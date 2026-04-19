import { ArrowCounterClockwise, ShieldSlash, DeviceMobile } from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Device } from '@/module_bindings/types';

export function RotationShareDialog({
  open,
  onOpenChange,
  devices,
  currentDeviceId,
  shareDeviceIds,
  revokeDeviceIds,
  busy,
  onShareChange,
  onRevokeChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  devices: Device[];
  currentDeviceId: string | null;
  shareDeviceIds: string[];
  revokeDeviceIds: string[];
  busy: boolean;
  onShareChange: (deviceId: string, checked: boolean) => void;
  onRevokeChange: (deviceId: string, checked: boolean) => void;
  onConfirm: () => void | Promise<void>;
}) {
  const selectedShareCount = shareDeviceIds.filter(deviceId => deviceId !== currentDeviceId).length;
  const selectedRevokeCount = revokeDeviceIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto border-border bg-background/95">
        <DialogHeader>
          <DialogTitle>Rotate Keys Across Devices</DialogTitle>
          <DialogDescription>
            Choose which approved devices should receive the new private keys and which ones should
            be revoked as part of this rotation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
            This browser will keep the new keys automatically. Other approved devices can either be
            synced with the rotated keys or revoked during the same update.
          </div>

          <div className="space-y-3">
            {devices.map(device => {
              const isCurrentDevice = device.deviceId === currentDeviceId;
              const shareChecked = shareDeviceIds.includes(device.deviceId);
              const revokeChecked = revokeDeviceIds.includes(device.deviceId);

              return (
                <div
                  key={device.deviceId}
                  className="space-y-3 rounded-md border border-border px-4 py-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">
                      {device.label?.trim() || device.deviceId}
                    </p>
                    <Badge variant="outline">{device.status}</Badge>
                    {isCurrentDevice ? <Badge variant="secondary">this browser</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {device.platform ?? 'unknown platform'}
                  </p>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex items-start gap-3 rounded-xl border border-border px-3 py-3">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={shareChecked}
                        disabled={busy || isCurrentDevice}
                        onChange={event => onShareChange(device.deviceId, event.target.checked)}
                      />
                      <span className="space-y-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <DeviceMobile className="h-4 w-4" />
                          Sync rotated keys
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Deliver the new private keys to this approved device.
                        </span>
                      </span>
                    </label>

                    <label className="flex items-start gap-3 rounded-xl border border-border px-3 py-3">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={revokeChecked}
                        disabled={busy || isCurrentDevice}
                        onChange={event => onRevokeChange(device.deviceId, event.target.checked)}
                      />
                      <span className="space-y-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <ShieldSlash className="h-4 w-4" />
                          Revoke this device
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Remove this device’s access during the same rotation.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="rounded-md border border-primary/20 bg-primary/10 px-4 py-4 text-sm">
            <p className="font-medium text-foreground">Summary</p>
            <p className="mt-1 text-muted-foreground">
              {selectedShareCount > 0
                ? `Sync ${selectedShareCount.toString()} device(s) with the rotated keys.`
                : 'Do not sync any other approved devices.'}{' '}
              {selectedRevokeCount > 0
                ? `Revoke ${selectedRevokeCount.toString()} device(s).`
                : 'No devices will be revoked.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void onConfirm()} disabled={busy}>
            <ArrowCounterClockwise className="h-4 w-4" />
            {busy
              ? 'Rotating…'
              : selectedShareCount > 0 || selectedRevokeCount > 0
                ? 'Rotate and update devices'
                : 'Rotate only this browser'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
