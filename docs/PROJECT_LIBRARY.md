# Projects and revisions

Open **Projects and revisions** in the application header to keep named projects and checkpoints in the current browser. This is independent of the existing last-session autosave: an untouched starting landscape still does not overwrite the previous session, and downloading a `.nhterrain.json` file continues to work as before.

## Designer workflow

- **Save checkpoint** records the complete current document, including its graph, imported height data, World settings, materials, masks, and paint. An optional note describes the change. Repeating a save of identical content does not add a redundant revision.
- **Save as new project** makes an independent project from the current document. It is also the recovery action when another tab has updated the original project.
- **Open selected revision** verifies the saved data, then checkpoints the current document before switching. A failed verification or failed protective checkpoint leaves the document on screen unchanged. Opening an old revision does not rewrite the latest saved revision; a subsequent checkpoint creates a new head with the restored revision as its parent.
- **Download revision** verifies and exports a normal `.nhterrain.json` file. **Download current project** remains available even when browser storage is unavailable.
- **Remove saved project** asks for confirmation before removing that project and its revisions. It leaves the current document and unrelated projects unchanged.

The library retains the latest **20 revisions per project**, up to **50 projects** and **256 MiB** of snapshot data plus conservative metadata allowances. Old revisions are pruned only when that same project successfully commits a new checkpoint. The library never evicts another project to admit a save. Snapshots shared by copied projects occupy storage once and are removed only after their final retained reference is gone.

Storage belongs to this browser and device. **Protect browser storage** requests the browser's persistent-storage permission; the browser decides whether to grant it. Persistent storage is not a substitute for downloadable backups, and clearing site data removes the library.

## Integrity and transaction contract

The database `normal-height.project-library.v1` has three stores:

| Store       | Key           | Content                                                                     |
| ----------- | ------------- | --------------------------------------------------------------------------- |
| `projects`  | Project UUID  | Name, creation/update time, current revision ID                             |
| `revisions` | Revision UUID | Project ID, parent revision ID, note, timestamp, SHA-256, compact file size |
| `snapshots` | SHA-256       | Compact `.nhterrain.json` text and encoded size                             |

Project files are validated and hashed before the database transaction starts. A save checks the expected head, admits the proposed storage footprint, writes the snapshot and revision, updates the project head, and prunes expired revisions in **one readwrite transaction**. Success is reported only after transaction completion. Aborts, quota errors, serialization failures, and stale heads cannot expose a partial revision or remove a previously committed checkpoint.

Readwrite transactions serialize concurrent browser writers. Each editing document retains the head it observed; a save or deletion rejects a different current head with a clear conflict message. The user can preserve the local document as a new project without overwriting another tab's work. Undo/redo tracks document identity separately from the portable project schema, including when history crosses an import or revision restore.

Restoration checks metadata, payload length, SHA-256, and the normal project parser. A corrupted revision is not silently accepted. An older healthy revision can still be selected when a payload is damaged. Invalid library metadata is reported without modifying stored records; external project downloads remain the recovery path for metadata damage.

## Qualification

`tests/project-library.test.ts` covers ancestry, unchanged saves, restoration, stale-head conflicts, revision retention, shared snapshot accounting, budget admission, clock rollback, and metadata corruption. `tests/project-library-storage.test.ts` exercises the actual persistence functions using the `fake-indexeddb` implementation of the IndexedDB API, including atomic rollback, concurrency, snapshot integrity, shared-content lifetime, unavailable storage, and a blocked upgrade that later resumes. This is transactional API coverage, not a claim about a browser's disk implementation.

`tests/e2e/project-library.spec.ts` exercises real IndexedDB through the production UI, including transaction rollback after a queued snapshot write, injected quota failure and retry, payload corruption, two-tab conflicts, portable downloads, reload, undo identity, and narrow-screen layout. The dedicated `project-durability-qa.yml` workflow runs these browser scenarios without retries and uploads the evidence.

These checks do not claim that browser-managed storage is a backup service, synchronize projects between devices, or qualify every browser's storage implementation. The library does not change the v1/v2 portable project format or replace the single-session autosave implementation.
