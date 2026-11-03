// The File System Access API pieces the updater uses that TypeScript's bundled DOM
// typings do not declare. Chromium-only, which is all this extension runs on.

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
}

interface Window {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
