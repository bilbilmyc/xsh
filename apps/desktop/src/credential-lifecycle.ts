export async function rollbackUncommittedCredentials(
  sessionPersisted: boolean,
  credentialRefs: readonly string[],
  deleteCredential: (credentialRef: string) => Promise<void>,
): Promise<void> {
  if (sessionPersisted) return;
  await Promise.all(
    credentialRefs.map((credentialRef) =>
      deleteCredential(credentialRef).catch(() => undefined),
    ),
  );
}
