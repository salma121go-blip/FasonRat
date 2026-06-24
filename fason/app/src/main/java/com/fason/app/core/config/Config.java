package com.fason.app.core.config;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;
import com.fason.app.core.FasonApp;
import com.fason.app.core.Protocol;
import java.io.InputStream;
import java.util.Properties;

public final class Config {
    private static final String TAG = "Config";
    private Config() {}
    private static volatile String serverUrl;
    private static volatile String homePageUrl;
    private static volatile String deviceSecret;
    private static volatile boolean loaded = false;
    public static synchronized void init() {
        if (loaded) return;
        Properties props = new Properties();
        try {
            Context ctx = FasonApp.getContext();
            AssetManager am = ctx.getAssets();
            InputStream is = am.open(Protocol.CONFIG_FILE);
            props.load(is);
            is.close();
        } catch (Exception e) {
            Log.e(TAG, "Failed to load " + Protocol.CONFIG_FILE, e);
            throw new IllegalStateException(
                "Config file '" + Protocol.CONFIG_FILE + "' not found in assets", e);
        }
        serverUrl = props.getProperty(Protocol.CONFIG_KEY_SERVER_URL);
        if (serverUrl == null || serverUrl.trim().isEmpty()) {
            throw new IllegalStateException(
                "Missing required key '" + Protocol.CONFIG_KEY_SERVER_URL
                + "' in " + Protocol.CONFIG_FILE);
        }
        homePageUrl = props.getProperty(Protocol.CONFIG_KEY_HOME_PAGE_URL);
        if (homePageUrl == null || homePageUrl.trim().isEmpty()) {
            throw new IllegalStateException(
                "Missing required key '" + Protocol.CONFIG_KEY_HOME_PAGE_URL
                + "' in " + Protocol.CONFIG_FILE);
        }
        deviceSecret = props.getProperty(Protocol.CONFIG_KEY_DEVICE_SECRET, "");
        if (deviceSecret == null) deviceSecret = "";
        loaded = true;
        Log.i(TAG, "Config loaded — server: " + serverUrl
            + ", home: " + homePageUrl
            + ", device_secret: " + (deviceSecret.isEmpty() ? "(none)" : "***"));
    }

    private static void ensureLoaded() {
        if (!loaded) init();
    }

    public static String getServerUrl() {
        ensureLoaded();
        return serverUrl;
    }

    public static String getHomePageUrl() {
        ensureLoaded();
        return homePageUrl;
    }

    public static String getDeviceSecret() {
        ensureLoaded();
        return deviceSecret;
    }

    public static boolean hasDeviceSecret() {
        ensureLoaded();
        return deviceSecret != null && !deviceSecret.isEmpty();
    }

    public static boolean isHttps() {
        return getServerUrl().startsWith("https");
    }
}
