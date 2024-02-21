/// <reference lib="webworker" />
import {
  IDB_KEYS,
  type Editor,
  type FileEntry,
  type Source,
} from "@/constants";
import * as Comlink from "comlink";
import { delMany } from "idb-keyval";
import { newfileContents } from "./data/newfile-content";
import type {
  CodeEditor,
  SaveEditorProps,
  SaveEditorResponse,
  SessionState,
} from "./types";

type SessionFiles = Pick<
  SessionState,
  "directoryHandle" | "sources" | "editors" | "sessionId"
>;

// ------- Get session directory handle ------- //

const getSessionDirectory = async (sessionId: string) => {
  const root = await navigator.storage.getDirectory();

  // the session name shouldn't have any slashes but if it does, we'll split it and create the directories.
  const directories = sessionId.split("/");

  let directoryHandle = root;
  for (const dir of directories) {
    directoryHandle = await directoryHandle.getDirectoryHandle(dir, {
      create: true,
    });
  }

  return directoryHandle;
};

// ------- Initialize session (get files) ------- //

const onInitialize = async (sessionId: string) => {
  postMessage({
    type: "INITIALIZE_SESSION_START",
    payload: {
      sessionId,
    },
  });

  try {
    const directoryHandle = await getSessionDirectory(sessionId);

    const sources: FileEntry<"SOURCE">[] = [];
    const editors: FileEntry<"EDITOR">[] = [];

    // retrieve dataset sources, code editor files.
    // Ignore directories as we are using a flat file structure.
    for await (const [name, handle] of directoryHandle.entries()) {
      if (handle.kind === "directory") continue;

      const meta = getMimeType(name);

      if (!meta) continue;

      const { mimeType, kind, ext } = meta;

      switch (kind) {
        case "EDITOR": {
          const entry: FileEntry<"EDITOR"> = {
            path: name,
            kind,
            ext,
            mimeType,
            handle,
          };
          editors.push(entry);
          postMessage({
            type: "INITIALIZE_EDITOR_FILE",
            payload: entry,
          });
          break;
        }
        case "SOURCE": {
          const entry: FileEntry<"SOURCE"> = {
            path: name,
            kind,
            ext,
            mimeType,
            handle,
          };
          sources.push(entry);
          postMessage({
            type: "INITIALIZE_SOURCE_FILE",
            payload: entry,
          });
          break;
        }
        default:
          break;
      }
    }

    // if there are no files, create a new editor with default comments and snippets.
    if (editors.length === 0) {
      const draftHandle = await directoryHandle.getFileHandle("new-query.sql", {
        create: true,
      });
      const syncHandle = await draftHandle.createSyncAccessHandle();

      const textEncoder = new TextEncoder();
      syncHandle.write(textEncoder.encode(newfileContents));

      syncHandle.flush();
      syncHandle.close();

      const entry: FileEntry<"EDITOR"> = {
        path: "new-query.sql",
        kind: "EDITOR",
        ext: "sql",
        mimeType: "text/sql",
        handle: draftHandle,
      };
      editors.push(entry);
      postMessage({
        type: "INITIALIZE_EDITOR_FILE",
        payload: entry,
      });
    }

    const editorsWithContent: CodeEditor[] = [];

    for await (const editor of editors) {
      const isFirst = editorsWithContent.length === 0;
      const file = await editor.handle.getFile();
      const content = await file.text();
      editorsWithContent.push({
        ...editor,
        content,
        isOpen: isFirst,
        isFocused: isFirst,
        isSaved: true,
        isDirty: false,
        isNew: false,
      });
    }

    const sessionFiles: SessionFiles = {
      sessionId,
      directoryHandle,
      sources,
      editors: editorsWithContent,
    };

    postMessage({
      type: "INITIALIZE_SESSION_COMPLETE",
      payload: sessionFiles,
    });

    return sessionFiles;
  } catch (e) {
    console.error("Error initializing session in worker: ", e);
    postMessage({
      type: "INITIALIZE_SESSION_ERROR",
      payload: {
        error: e instanceof Error ? e.message : "Unknown error",
      },
    });
    return null;
  }
};

function getMimeType(
  name: string,
):
  | Pick<Source, "mimeType" | "kind" | "ext">
  | Pick<Editor, "mimeType" | "kind" | "ext">
  | null {
  const lastDot = name.lastIndexOf("."); // allow index.worker.ts
  if (lastDot === -1) {
    return null;
  }
  const ext = name.slice(lastDot + 1);
  if (!ext) return null;

  switch (ext) {
    case "csv":
      return { mimeType: "text/csv", kind: "SOURCE", ext: "csv" };
    case "json":
      return { mimeType: "application/json", kind: "SOURCE", ext: "json" };
    case "txt":
      return { mimeType: "text/plain", kind: "SOURCE", ext: "txt" };
    case "duckdb":
      return { mimeType: "application/duckdb", kind: "SOURCE", ext: "duckdb" };
    case "sqlite":
      return { mimeType: "application/sqlite", kind: "SOURCE", ext: "sqlite" };
    case "postgresql":
      return {
        mimeType: "application/postgresql",
        kind: "SOURCE",
        ext: "postgresql",
      };
    case "parquet":
      return {
        mimeType: "application/parquet",
        kind: "SOURCE",
        ext: "parquet",
      };
    case "arrow":
      return { mimeType: "application/arrow", kind: "SOURCE", ext: "arrow" };
    case "excel":
      return { mimeType: "application/excel", kind: "SOURCE", ext: "excel" };
    case "sql":
      return { mimeType: "text/sql", kind: "EDITOR", ext: "sql" };
    case "js":
      return { mimeType: "text/javascript", kind: "EDITOR", ext: "js" };
    case "py":
      return { mimeType: "text/python", kind: "EDITOR", ext: "py" };
    case "ts":
      return { mimeType: "text/typescript", kind: "EDITOR", ext: "ts" };
    case "rs":
      return { mimeType: "text/rust", kind: "EDITOR", ext: "rs" };
    default:
      return null;
  }
}

// --- Add new data source -- //

/**
 * If we receive a file handle, it's from the user's local file system and we need to copy and store it in the opfs.
 */
type NewSourceType = "FILE" | "URL";

type AddSourceBase = {
  sessionId: string;
  name: string; // with the extension
};

type OnAddSourceProps<T extends NewSourceType> = T extends "FILE"
  ? {
      type: T;
      handle: FileSystemFileHandle;
    }
  : {
      type: T;
      url: string;
    };

const onAddSource = async <T extends NewSourceType>(
  props: AddSourceBase & OnAddSourceProps<T>,
) => {
  const { type, name, sessionId } = props;
  postMessage({
    type: "ADD_SOURCE_START",
    payload: {
      name,
      type,
    },
  });

  const directory = await getSessionDirectory(sessionId);

  const meta = getMimeType(name);

  if (!meta || meta.kind !== "SOURCE") {
    console.error("Invalid file type: ", name);
    postMessage({
      type: "ADD_SOURCE_ERROR",
      payload: {
        name,
        type,
      },
    });
    return null;
  }

  // Check that the file name is unique. If not, append a number to the end.
  let counter = 0;
  const paths = name.split(".");
  const ext = paths.pop();
  let path = paths.join(".");

  while (true) {
    const exists = await directory
      .getFileHandle(name, { create: false })
      .catch(() => null);
    if (!exists) break;
    counter++;
    path = `${path}-${counter}`;
  }

  const filename = `${path}.${ext}`;

  try {
    switch (type) {
      case "FILE": {
        const { handle } = props;
        const file = await handle.getFile();

        const draftHandle = await directory.getFileHandle(filename, {
          create: true,
        });
        const accessHandle = await draftHandle.createSyncAccessHandle();

        const buffer = await file.arrayBuffer();

        accessHandle.write(buffer);
        // Flush the changes.
        accessHandle.flush();
        accessHandle.close();

        const source: FileEntry<"SOURCE"> = {
          path: filename,
          kind: meta.kind,
          mimeType: meta.mimeType,
          ext: meta.ext,
          handle: draftHandle, // not the original file handle we received.
        };

        postMessage({
          type: "SOURCE_FILE_COMPLETE",
          payload: source,
        });

        return source;
      }
      // save URL as a URI file (don't download the file, just store the URL as a file in the opfs).
      case "URL": {
        const { url } = props;
        const draftHandle = await directory.getFileHandle(path, {
          create: true,
        });
        const accessHandle = await draftHandle.createSyncAccessHandle();
        const textEncoder = new TextEncoder();
        const buffer = textEncoder.encode(url);
        accessHandle.write(buffer);
        // Flush the changes.
        accessHandle.flush();
        accessHandle.close();

        const source: FileEntry<"SOURCE"> = {
          path: name,
          kind: meta.kind,
          mimeType: meta.mimeType,
          ext: meta.ext,
          handle: draftHandle,
        };

        postMessage({
          type: "SOURCE_FILE_COMPLETE",
          payload: source,
        });

        return source;
      }
    }
  } catch (e) {
    console.error("Error adding source: ", e);
    postMessage({
      type: "ADD_SOURCE_ERROR",
      payload: {
        name,
        type,
      },
    });
    return null;
  }
};

// --- Add new editor file -- //

const onAddEditor = async (sessionId: string) => {
  postMessage({
    type: "ADD_EDITOR_START",
    payload: {
      sessionId,
    },
  });

  try {
    const directory = await getSessionDirectory(sessionId);

    // find a unique name for the new file
    let counter = 0;
    let path = "new-query";
    let filename = "new-query.sql";

    while (true) {
      const exists = await directory
        .getFileHandle(filename, { create: false })
        .catch(() => null);
      if (!exists) break;
      counter++;
      path = `${path}-${counter}`;
      filename = `${path}.sql`;
    }

    const draftHandle = await directory.getFileHandle(filename, {
      create: true,
    });

    const syncHandle = await draftHandle.createSyncAccessHandle();

    const textEncoder = new TextEncoder();
    syncHandle.write(textEncoder.encode(newfileContents));

    syncHandle.flush();
    syncHandle.close();

    const entry: FileEntry<"EDITOR"> = {
      path: filename,
      kind: "EDITOR",
      ext: "sql",
      mimeType: "text/sql",
      handle: draftHandle,
    };

    postMessage({
      type: "ADD_EDITOR_COMPLETE",
      payload: entry,
    });

    return entry;
  } catch (e) {
    console.error("Error adding editor file: ", e);
    postMessage({
      type: "ADD_EDITOR_ERROR",
      payload: {
        error: e instanceof Error ? e.message : "Unknown error",
      },
    });
    return null;
  }
};

// ------- Delete editor file ------- //

/**
 * Permanently delete the editor file.
 *
 * #TODO: archive the file instead of deleting it.
 */
async function onDeleteEditor({
  sessionId,
  path,
}: {
  sessionId: string;
  path: string;
}) {
  postMessage({
    type: "DELETE_EDITOR_START",
    payload: {
      sessionId,
      path,
    },
  });

  try {
    const directory = await getSessionDirectory(sessionId);
    await directory.removeEntry(path, { recursive: true });
    postMessage({
      type: "DELETE_EDITOR_COMPLETE",
      payload: {
        sessionId,
        path,
        error: null,
      },
    });

    return {
      sessionId,
      path,
      error: null,
    };
  } catch (e) {
    console.error(`Error deleting editor file: ${path} `, e);
    postMessage({
      type: "DELETE_EDITOR_ERROR",
      payload: {
        sessionId,
        path,
        error: e instanceof Error ? e.message : "Unknown error",
      },
    });

    return {
      sessionId,
      path,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

// ------- Save editor file ------- //

async function onSaveEditor({
  content,
  path,
  sessionId,
}: SaveEditorProps & {
  sessionId: string;
}): Promise<SaveEditorResponse> {
  postMessage({
    type: "SAVE_FILE_START",
    payload: {
      sessionId,
      path,
    },
  });

  let draftHandle: FileSystemFileHandle | undefined;

  try {
    const directory = await getSessionDirectory(sessionId);

    draftHandle = await directory.getFileHandle(path, {
      create: true,
    });

    const syncHandle = await draftHandle.createSyncAccessHandle();

    const textEncoder = new TextEncoder();

    const buffer = textEncoder.encode(content);

    syncHandle.truncate(0); // clear the file

    syncHandle.write(buffer, {
      at: 0,
    });

    syncHandle.flush();
    syncHandle.close();

    const payload: SaveEditorResponse = {
      handle: draftHandle,
      content,
      path,
      error: null,
    };

    postMessage({
      type: "SAVED_FILE_COMPLETE",
      payload,
    });

    return payload;
  } catch (error) {
    console.error(`Error saving file: ${path}: `, error);
    const payload: SaveEditorResponse = {
      handle: draftHandle,
      content,
      path,
      error: error instanceof Error ? error : new Error("Unknown error"),
    };
    postMessage({
      type: "SAVE_ERROR",
      payload: payload,
    });

    return payload;
  }
}

// ------- Burst cache ------- //

const clearCacheAPI = async () => {
  const cacheKeys = await caches.keys();
  return Promise.all(cacheKeys.map((key) => caches.delete(key)));
};

const clearIDB = async () => {
  const keys = Object.keys(IDB_KEYS);
  return delMany(keys);
};

type OnBurstCacheResponse = {
  sessionId: string;
  error: string | null;
};

/**
 * Clear the session cache (files, datasets, query results).
 */
async function onBurstCache({
  sessionId,
}: {
  sessionId: string;
}): Promise<OnBurstCacheResponse> {
  postMessage({
    type: "BURST_CACHE_START",
    payload: null,
  });

  const root = await navigator.storage.getDirectory();

  try {
    const clearOPFS = root.removeEntry(sessionId, { recursive: true });

    await Promise.all([clearOPFS, clearCacheAPI(), clearIDB()]);

    postMessage({
      type: "BURST_CACHE_COMPLETE",
      payload: null,
    });

    return {
      sessionId,
      error: null,
    };
  } catch (e) {
    console.error("Error bursting cache: ", e);
    postMessage({
      type: "BURST_CACHE_ERROR",
      payload: {
        error: e instanceof Error ? e.message : "Unknown error",
      },
    });

    return {
      sessionId,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

// ----------------------------//

const methods = {
  onInitialize,
  onAddSource,
  onAddEditor,
  onDeleteEditor,
  onSaveEditor,
  onBurstCache,
};

export type SessionWorker = typeof methods;
Comlink.expose(methods);
