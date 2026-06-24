import { useState, useEffect, useRef } from 'react';
import { authApi, configApi } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Save, AlertCircle, CheckCircle, User, Lock, ShieldCheck, Shield, KeyRound, RefreshCw, Eye, EyeOff, Monitor, Trash2 } from 'lucide-react';

function generateRandomSecret(len = 32): string {
  const bytes = new Uint8Array(len / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default function SettingsPage() {
  const { user, checkAuth, hasPermission } = useAuthStore();

  const [profileUsername, setProfileUsername] = useState(user?.username || '');
  const [profileEmail, setProfileEmail] = useState(user?.email || '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [deviceSecretEnabled, setDeviceSecretEnabled] = useState<boolean | null>(null);
  const [currentSecret, setCurrentSecret] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [secretVisible, setSecretVisible] = useState(false);
  const [secretSaving, setSecretSaving] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [secretSuccess, setSecretSuccess] = useState<string | null>(null);
  const secretTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canEditSettings = hasPermission('settings:edit');

  interface SessionInfo {
    id: number;
    userId: number;
    username: string;
    ip: string;
    createdAt: string;
    expiresAt: string;
    tokenPreview: string;
    isCurrent: boolean;
  }
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const profileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      if (passwordTimerRef.current) clearTimeout(passwordTimerRef.current);
      if (secretTimerRef.current) clearTimeout(secretTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!hasPermission('settings:view')) return;
    configApi.get()
      .then((res) => {
        if (res.data.success) {
          const sec = res.data.data?.security;
          setDeviceSecretEnabled(!!sec?.deviceSecretEnabled);
          const value = typeof sec?.deviceSecret === 'string' ? sec.deviceSecret : '';
          setCurrentSecret(value);
          setSecretInput(value);
        }
      })
      .catch(() => {  });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSecretSave = async () => {
    setSecretSaving(true);
    setSecretError(null);
    setSecretSuccess(null);
    try {
      const value = secretInput.trim();
      if (value.length > 0 && value.length < 8) {
        setSecretError('Secret must be at least 8 characters');
        setSecretSaving(false);
        return;
      }
      const res = await configApi.setDeviceSecret(value);
      if (res.data.success) {
        setDeviceSecretEnabled(!!res.data.enabled);

        const savedValue = typeof res.data.value === 'string' ? res.data.value : value;
        setCurrentSecret(savedValue);
        setSecretInput(savedValue);
        setSecretSuccess(value ? 'Device authentication enabled. Rebuild the APK to embed the new secret.' : 'Device authentication disabled. Rebuild the APK to remove the secret.');
        if (secretTimerRef.current) clearTimeout(secretTimerRef.current);
        secretTimerRef.current = setTimeout(() => setSecretSuccess(null), 6000);
      } else {
        setSecretError(res.data.error || 'Failed to update device secret');
      }
    } catch (err: any) {
      setSecretError(err?.response?.data?.error || 'Failed to update device secret');
    }
    setSecretSaving(false);
  };

  const handleSecretDisable = async () => {
    setSecretSaving(true);
    setSecretError(null);
    setSecretSuccess(null);
    try {
      const res = await configApi.setDeviceSecret('');
      if (res.data.success) {
        setDeviceSecretEnabled(false);
        setCurrentSecret('');
        setSecretInput('');
        setSecretSuccess('Device authentication disabled. Rebuild the APK to remove the secret.');
        if (secretTimerRef.current) clearTimeout(secretTimerRef.current);
        secretTimerRef.current = setTimeout(() => setSecretSuccess(null), 6000);
      } else {
        setSecretError(res.data.error || 'Failed to disable device secret');
      }
    } catch (err: any) {
      setSecretError(err?.response?.data?.error || 'Failed to disable device secret');
    }
    setSecretSaving(false);
  };

  const handleGenerateRandom = () => {
    setSecretInput(generateRandomSecret(32));
    setSecretError(null);
    setSecretSuccess(null);
  };

  const fetchSessions = async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const res = await authApi.sessions();
      if (res.data.success) {
        setSessions(Array.isArray(res.data.data) ? res.data.data : []);
      } else {
        setSessionsError(res.data.error || 'Failed to load sessions');
      }
    } catch (err: any) {
      setSessionsError(err?.response?.data?.error || 'Failed to load sessions');
    }
    setSessionsLoading(false);
  };

  const handleRevokeSession = async (id: number) => {
    setRevokingId(id);
    try {
      const res = await authApi.revokeSession(id);
      if (res.data.success) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
      } else {
        setSessionsError(res.data.error || 'Failed to revoke session');
      }
    } catch (err: any) {
      setSessionsError(err?.response?.data?.error || 'Failed to revoke session');
    }
    setRevokingId(null);
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  useEffect(() => {
    if (user) {
      setProfileUsername(user.username);
      setProfileEmail(user.email || '');
    }
  }, [user]);

  const handleProfileSave = async () => {
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(false);
    try {
      const updates: { username?: string; email?: string } = {};
      if (profileUsername !== user?.username) updates.username = profileUsername;
      if (profileEmail !== user?.email) updates.email = profileEmail;
      if (Object.keys(updates).length > 0) {
        const res = await authApi.updateProfile(updates);
        if (res.data.success) {
          await checkAuth();
          setProfileSuccess(true);
          if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
          profileTimerRef.current = setTimeout(() => setProfileSuccess(false), 3000);
        } else {
          setProfileError(res.data.error || 'Failed to update profile');
        }
      }
    } catch (err: any) {
      setProfileError(err?.response?.data?.error || 'Failed to update profile');
    }
    setProfileSaving(false);
  };

  const handlePasswordChange = async () => {
    if (newPassword !== confirmNewPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      return;
    }
    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordSuccess(false);
    try {
      const res = await authApi.changePassword(currentPassword, newPassword);
      if (res.data.success) {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
        setPasswordSuccess(true);
        if (passwordTimerRef.current) clearTimeout(passwordTimerRef.current);
        passwordTimerRef.current = setTimeout(() => setPasswordSuccess(false), 3000);
      } else {
        setPasswordError(res.data.error || 'Failed to change password');
      }
    } catch (err: any) {
      setPasswordError(err?.response?.data?.error || 'Failed to change password');
    }
    setPasswordSaving(false);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your account information</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <User className="h-5 w-5" /> Profile
          </CardTitle>
          <CardDescription>Update your account information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profileError && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" /> {profileError}
            </div>
          )}
          {profileSuccess && (
            <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0" /> Profile updated successfully
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="profile-username">Username</Label>
              <Input
                id="profile-username"
                type="text"
                value={profileUsername}
                onChange={(e) => setProfileUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                type="email"
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={user?.role === 'admin' ? 'default' : 'secondary'} className="gap-1">
              {user?.role === 'admin' ? <ShieldCheck className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
              {user?.role === 'admin' ? 'Administrator' : 'User'}
            </Badge>
          </div>
          <Button onClick={handleProfileSave} disabled={profileSaving} className="gap-2">
            {profileSaving ? 'Saving...' : <><Save className="h-4 w-4" /> Save Profile</>}
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Lock className="h-5 w-5" /> Change Password
          </CardTitle>
          <CardDescription>Update your account password</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {passwordError && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" /> {passwordError}
            </div>
          )}
          {passwordSuccess && (
            <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0" /> Password changed successfully
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              placeholder="Enter current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-new-password">Confirm New Password</Label>
              <Input
                id="confirm-new-password"
                type="password"
                placeholder="Confirm new password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={handlePasswordChange} disabled={passwordSaving || !currentPassword || !newPassword || !confirmNewPassword} className="gap-2">
            {passwordSaving ? 'Changing...' : <><Lock className="h-4 w-4" /> Change Password</>}
          </Button>
        </CardContent>
      </Card>

      {hasPermission('settings:view') && (
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <KeyRound className="h-5 w-5" /> Device Authentication
            </CardTitle>
            <CardDescription>
              Require a shared secret for new device connections. Disabled by default.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Status:</span>
              {deviceSecretEnabled === null ? (
                <Badge variant="secondary">Unknown</Badge>
              ) : deviceSecretEnabled ? (
                <Badge className="gap-1 bg-success/15 text-success border-success/30 hover:bg-success/15">
                  <ShieldCheck className="h-3 w-3" /> Enabled
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <Shield className="h-3 w-3" /> Disabled
                </Badge>
              )}
            </div>

            {}
            {deviceSecretEnabled && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-sm flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Already-registered devices will keep working until they reconnect.</p>
                  <p className="mt-1 opacity-90">Any device that reconnects (or any newly built APK) must present this secret. Rebuild the APK after changing the secret so it carries the new value.</p>
                </div>
              </div>
            )}

            {secretError && (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" /> {secretError}
              </div>
            )}
            {secretSuccess && (
              <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm flex items-start gap-2">
                <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" /> <span>{secretSuccess}</span>
              </div>
            )}

            {canEditSettings && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="device-secret">Secret</Label>
                  <div className="flex gap-2">
                    <Input
                      id="device-secret"
                      type={secretVisible ? 'text' : 'password'}
                      placeholder="Type or click Generate"
                      value={secretInput}
                      onChange={(e) => { setSecretInput(e.target.value); setSecretError(null); setSecretSuccess(null); }}
                      className="font-mono text-sm"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setSecretVisible(!secretVisible)}
                      disabled={secretSaving}
                      title={secretVisible ? 'Hide secret' : 'Show secret'}
                      aria-label={secretVisible ? 'Hide secret' : 'Show secret'}
                      className="shrink-0"
                    >
                      {secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleGenerateRandom}
                      disabled={secretSaving}
                      title="Generate a random 32-char hex secret"
                      className="gap-2 shrink-0"
                    >
                      <RefreshCw className="h-4 w-4" /> Generate
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {currentSecret
                      ? 'Current secret is hidden. Click the eye to reveal it, or Generate to rotate.'
                      : 'Min 8 chars. Saved value is hidden — click the eye to reveal.'}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={handleSecretSave}
                    disabled={secretSaving || !secretInput.trim()}
                    className="gap-2"
                  >
                    {secretSaving ? 'Saving...' : (
                      deviceSecretEnabled
                        ? <><Save className="h-4 w-4" /> Update Secret</>
                        : <><ShieldCheck className="h-4 w-4" /> Enable</>
                    )}
                  </Button>
                  {deviceSecretEnabled && (
                    <Button
                      onClick={handleSecretDisable}
                      variant="destructive"
                      disabled={secretSaving}
                      className="gap-2"
                    >
                      <Shield className="h-4 w-4" /> Disable
                    </Button>
                  )}
                </div>
              </>
            )}

            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">You need the <code>settings:edit</code> permission to change the device secret.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Monitor className="h-5 w-5" /> Active Sessions
          </CardTitle>
          <CardDescription>Devices currently logged into your account{user?.role === 'admin' ? ' (admin sees all users)' : ''}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sessionsError && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" /> {sessionsError}
            </div>
          )}

          {sessionsLoading ? (
            <p className="text-sm text-muted-foreground">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active sessions.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg border bg-card/50">
                  <div className="h-9 w-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                    <Monitor className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{s.username || `User #${s.userId}`}</span>
                      {s.isCurrent && (
                        <Badge variant="secondary" className="text-xs">This device</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>IP: <span className="font-mono">{s.ip || 'unknown'}</span></span>
                      <span>Token: <span className="font-mono">{s.tokenPreview || '—'}</span></span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      <span>Started: {new Date(s.createdAt).toLocaleString()}</span>
                      <span className="mx-1">·</span>
                      <span>Expires: {new Date(s.expiresAt).toLocaleString()}</span>
                    </div>
                  </div>
                  {!s.isCurrent && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRevokeSession(s.id)}
                      disabled={revokingId !== null}
                      className="gap-1 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> {revokingId === s.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={fetchSessions} disabled={sessionsLoading} className="gap-2 text-xs">
            <RefreshCw className={`h-3 w-3 ${sessionsLoading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
