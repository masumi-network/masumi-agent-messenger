import { describe, expect, it } from 'vitest';
import type { TaskReporter } from './command-runtime';
import { resolveRotationDeviceSelection } from './key-rotation-device-selection';

const reporter: TaskReporter = {
  info() {},
  success() {},
};

describe('resolveRotationDeviceSelection', () => {
  it('does not share when only revoke devices are provided', async () => {
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
      revokeDeviceIds: ['device-b'],
    });
  });

  it('keeps json rotations explicit-share only', async () => {
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
      revokeDeviceIds: ['device-b'],
    });
  });
});
