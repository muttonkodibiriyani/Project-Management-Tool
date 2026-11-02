import type { ContainerClient } from '@azure/storage-blob';

/** Tests that never call a file route still pass the production app's required Blob dependency. */
export const unusedBlobs = {} as ContainerClient;
