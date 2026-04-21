import { describe, expect, it } from 'vitest';
import type { TaskReporter } from './command-runtime';
import { resolveRotationDeviceSelection } from './key-rotation-device-selection';

const reporter: TaskReporter = {
  info() {},
  success() {},
};

describe('resolveRotationDeviceSelection', () => {
  it('keeps default sharing enabled for human revoke-only rotations', async () => {
    await expect(
      resolveRotationDeviceSelection({
        profileName: 'default',
        json: false,
        reporter,
        explicitShareDeviceIds: [],
        explicitRevokeDeviceIds: ['device-b'],
      })
    ).resolves.toEqual({
      shareDeviceIds: [],
      shareAllApprovedDevices: true,
      revokeDeviceIds: ['device-b'],
    });
  });

  it('keeps json revoke-only rotations aligned with human mode', async () => {
    await expect(
      resolveRotationDeviceSelection({
        profileName: 'default',
        json: true,
        reporter,
        explicitShareDeviceIds: [],
        explicitRevokeDeviceIds: ['device-b'],
      })
    ).resolves.toEqual({
      shareDeviceIds: [],
      shareAllApprovedDevices: true,
      revokeDeviceIds: ['device-b'],
    });
  });

  it('uses explicit sharing when share devices are provided', async () => {
    await expect(
      resolveRotationDeviceSelection({
        profileName: 'default',
        json: false,
        reporter,
        explicitShareDeviceIds: ['device-a'],
        explicitRevokeDeviceIds: ['device-b'],
      })
    ).resolves.toEqual({
      shareDeviceIds: ['device-a'],
      shareAllApprovedDevices: false,
      revokeDeviceIds: ['device-b'],
    });
  });
});
