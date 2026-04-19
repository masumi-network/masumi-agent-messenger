import { readFile } from 'node:fs/promises';
import { userError } from './errors';

export async function resolvePublicDescriptionOption(params: {
  description?: string;
  descriptionFile?: string;
}): Promise<string | undefined> {
  if (params.description && params.descriptionFile) {
    throw userError('Choose either `--public-description` or `--public-description-file`.', {
      code: 'PUBLIC_DESCRIPTION_OPTIONS_CONFLICT',
    });
  }

  if (params.descriptionFile) {
    return await readFile(params.descriptionFile, 'utf8');
  }

  return params.description;
}
