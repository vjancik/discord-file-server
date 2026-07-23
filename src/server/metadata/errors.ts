/**
 * A supported file could not be cleaned. Finalize maps this to an upload
 * rejection (fail closed): publishing dirty bytes while the user's strip
 * toggle is on would make the setting a lie exactly when it matters.
 */
export class MetadataStripError extends Error {}
