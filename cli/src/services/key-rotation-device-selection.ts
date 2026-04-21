import process from 'node:process';
import type { TaskReporter } from './command-runtime';
import { listRotationDeviceCandidates } from './inbox-management';
import { promptChoice } from './prompts';
import { cyan, dim } from './render';

type RotationDeviceDecision = 'share' | 'revoke' | 'skip';

export type RotationDeviceSelection = {
  shareDeviceIds: string[];
  revokeDeviceIds: string[];
};

function interactiveStdioAvailable(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function formatDeviceLabel(device: {
  deviceId: string;
  label: string | null;
  platform: string | null;
}): string {
  const label = device.label?.trim() || device.deviceId;
  const platform = device.platform?.trim();
  return platform ? `${label} ${dim(`(${platform})`)}` : label;
}

export async function resolveRotationDeviceSelection(params: {
  profileName: string;
  json: boolean;
  reporter: TaskReporter;
  explicitShareDeviceIds: string[];
  explicitRevokeDeviceIds: string[];
}): Promise<RotationDeviceSelection> {
  const explicitShareDeviceIds = Array.from(new Set(params.explicitShareDeviceIds));
  const explicitRevokeDeviceIds = Array.from(new Set(params.explicitRevokeDeviceIds));

  if (params.json) {
    return {
      shareDeviceIds: explicitShareDeviceIds,
      revokeDeviceIds: explicitRevokeDeviceIds,
    };
  }

  if (explicitShareDeviceIds.length > 0 || explicitRevokeDeviceIds.length > 0) {
    return {
      shareDeviceIds: explicitShareDeviceIds,
      revokeDeviceIds: explicitRevokeDeviceIds,
    };
  }

  if (!interactiveStdioAvailable()) {
    return {
      shareDeviceIds: [],
      revokeDeviceIds: [],
    };
  }

  const candidates = await listRotationDeviceCandidates({
    profileName: params.profileName,
    reporter: params.reporter,
  });
  const otherApprovedDevices = candidates.devices.filter(device => !device.isCurrentDevice);
  if (otherApprovedDevices.length === 0) {
    return {
      shareDeviceIds: [],
      revokeDeviceIds: [],
    };
  }

  params.reporter.info(
    'Review approved devices. Sync keeps them online after rotation; revoke removes future access.'
  );

  const shareDeviceIds: string[] = [];
  const revokeDeviceIds: string[] = [];

  for (const device of otherApprovedDevices) {
    const decision = await promptChoice<RotationDeviceDecision>({
      question: `After rotation, ${cyan(formatDeviceLabel(device))}:`,
      defaultValue: 'share',
      options: [
        { value: 'share', label: 'Sync rotated keys' },
        { value: 'revoke', label: 'Revoke device' },
        { value: 'skip', label: 'Leave unsynced' },
      ],
    });

    if (decision === 'share') {
      shareDeviceIds.push(device.deviceId);
      continue;
    }
    if (decision === 'revoke') {
      revokeDeviceIds.push(device.deviceId);
    }
  }

  return {
    shareDeviceIds,
    revokeDeviceIds,
  };
}
