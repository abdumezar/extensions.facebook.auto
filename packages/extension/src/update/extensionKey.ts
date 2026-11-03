/**
 * The public key that pins this extension's id (`jkfmfkdijopiodgfbdnpkileohkojojk`). It is
 * the public half of a throwaway pair, so it is safe to commit. The manifest is built from
 * it, and the updater requires every release's manifest to carry exactly this key: that is
 * what stops a signed release of some other extension from replacing this one's files.
 */
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhFnPjvRdfhaFa7wBPsg19OwHJSIBWhTlBiYDBptcTYI9OYnr9vxPpo+v+Zuw2r9PXGrNobzb1Ad66S4VgUXAfkyjZBAqLoEqpW2GXE+50flOU26Fr6WUCDFxL8xiJKQA2BeA2Bqsj/xjVmGMQFY7/VDqlVp4AMXKkOz5nYisLQZ/iskSSymNP1PvgreCIXB0wNpaEvAW/a5tQoD6XooxEBWvZZLa/NWvCc4U6KdCgXyQ/gd9QK7bNLir2hJHnPN5m2TfNvWhA6NXzf+Glc1eXVv6C4x1sblBlffTeISXGt/iDFJMq8tbpdbE6bCEthbgubHEWd/HEDYvDC87x911iwIDAQAB";
