// AVO_TEST_MODE is set by jest.setup.js, which runs before this file is imported.
import fs from 'fs';
import path from 'path';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import os from 'os';
import logSymbols from 'log-symbols';
import {
  getEventsDirectoryPath,
  isFilePerEventMode,
  eventNameToFileName,
  cleanupObsoleteEventFiles,
  buildFolderMessage,
  buildFilenameMessage,
  buildInterfaceFilenameMessage,
  extractConflictingFiles,
  buildResolvedAvoJson,
  buildAvoJsonFilterMismatchWarning,
  findUnresolvableAvoJsonConflict,
  LIBRARY_INTERFACE_FILE_FILTER_VALUES,
  parseLibraryInterfaceFileFilter,
  resolveLibraryInterfaceFileFilter,
  resolveLibraryInterfaceSharedModule,
  buildPullRequestBody,
  validateAvoJson,
  loadAvoJson,
  loadAvoJsonOrInit,
  applyBranchToAvoJson,
  codegen,
  applyPullResult,
  buildLibraryInterfaceFileFilterInfoLine,
  init,
  collectStaleSuppressedFiles,
  buildStaleSuppressedFileWarning,
  buildSourcePaths,
  resolveInspectorEnv,
  status,
} from './cli.js';
import { commitAll, git, useIsolatedGit } from './testGit.js';

// Each of these suites runs codegen against the real filesystem, so they need an
// isolated cwd. Declared once rather than repeated per describe block.
const useTempCwd = (): void => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-test-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
};

describe('File-per-event cleanup helper functions', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('getEventsDirectoryPath', () => {
    it('should return correct path for ./Avo.ts with module Avo', () => {
      const sourcePath = './Avo.ts';
      const moduleName = 'Avo';
      // path.join normalizes paths, removing leading ./
      const expected = 'AvoEvents';
      const result = getEventsDirectoryPath(sourcePath, moduleName);
      expect(result).toBe(expected);
    });

    it('should handle nested paths correctly', () => {
      const sourcePath = './src/analytics/Avo.ts';
      const moduleName = 'Avo';
      // path.join normalizes paths, removing leading ./
      const expected = 'src/analytics/AvoEvents';
      const result = getEventsDirectoryPath(sourcePath, moduleName);
      expect(result).toBe(expected);
    });
  });

  describe('isFilePerEventMode', () => {
    it('should return true when events directory exists', () => {
      const sourcePath = path.join(tempDir, 'Avo.ts');
      const moduleName = 'Avo';
      const eventsDir = path.join(tempDir, `${moduleName}Events`);
      fs.mkdirSync(eventsDir, { recursive: true });

      const result = isFilePerEventMode(sourcePath, moduleName);
      expect(result).toBe(true);
    });

    it('should return false when events directory does not exist', () => {
      const sourcePath = path.join(tempDir, 'Avo.ts');
      const moduleName = 'Avo';

      const result = isFilePerEventMode(sourcePath, moduleName);
      expect(result).toBe(false);
    });

    it('should return false when path exists but is a file not directory', () => {
      const sourcePath = path.join(tempDir, 'Avo.ts');
      const moduleName = 'Avo';
      const eventsDir = path.join(tempDir, `${moduleName}Events`);
      fs.writeFileSync(eventsDir, 'test');

      const result = isFilePerEventMode(sourcePath, moduleName);
      expect(result).toBe(false);
    });
  });

  describe('eventNameToFileName', () => {
    it('should convert EventClicked to eventClicked.ts for TypeScript', () => {
      const result = eventNameToFileName('EventClicked', '.ts');
      expect(result).toBe('eventClicked.ts');
    });

    it('should convert EventClicked to eventClicked.kt for Kotlin', () => {
      const result = eventNameToFileName('EventClicked', '.kt');
      expect(result).toBe('eventClicked.kt');
    });

    it('should convert EventClicked to eventClicked.swift for Swift', () => {
      const result = eventNameToFileName('EventClicked', '.swift');
      expect(result).toBe('eventClicked.swift');
    });

    it('should handle already camelCase eventClicked to eventClicked.ts', () => {
      const result = eventNameToFileName('eventClicked', '.ts');
      expect(result).toBe('eventClicked.ts');
    });

    it('should handle single word Click to click.ts', () => {
      const result = eventNameToFileName('Click', '.ts');
      expect(result).toBe('click.ts');
    });
  });

  describe('cleanupObsoleteEventFiles', () => {
    it('should delete files for events in old list but not in new list', () => {
      const eventsDir = path.join(tempDir, 'AvoEvents');
      fs.mkdirSync(eventsDir, { recursive: true });

      const oldEvents = ['EventClicked', 'EventViewed', 'EventDeleted'];
      const newEvents = ['EventClicked', 'EventViewed'];
      const extension = '.ts';

      // Create files for all old events
      oldEvents.forEach((eventName) => {
        const fileName = eventNameToFileName(eventName, extension);
        const filePath = path.join(eventsDir, fileName);
        fs.writeFileSync(filePath, '// test');
      });

      // Perform cleanup
      cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);

      // Verify deleted file doesn't exist
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.ts'))).toBe(
        false,
      );
      // Verify remaining files still exist
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.ts'))).toBe(true);
      expect(fs.existsSync(path.join(eventsDir, 'eventViewed.ts'))).toBe(true);
    });

    it('should delete Kotlin files with .kt extension', () => {
      const eventsDir = path.join(tempDir, 'AvoEvents');
      fs.mkdirSync(eventsDir, { recursive: true });

      const oldEvents = ['EventClicked', 'EventDeleted'];
      const newEvents = ['EventClicked'];
      const extension = '.kt';

      // Create files for all old events with .kt extension
      oldEvents.forEach((eventName) => {
        const fileName = eventNameToFileName(eventName, extension);
        const filePath = path.join(eventsDir, fileName);
        fs.writeFileSync(filePath, '// Kotlin test');
      });

      // Perform cleanup
      cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);

      // Verify deleted file doesn't exist
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.kt'))).toBe(
        false,
      );
      // Verify remaining file still exists
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.kt'))).toBe(true);
    });

    it('should delete Swift files with .swift extension', () => {
      const eventsDir = path.join(tempDir, 'AvoEvents');
      fs.mkdirSync(eventsDir, { recursive: true });

      const oldEvents = ['EventClicked', 'EventDeleted'];
      const newEvents = ['EventClicked'];
      const extension = '.swift';

      // Create files for all old events with .swift extension
      oldEvents.forEach((eventName) => {
        const fileName = eventNameToFileName(eventName, extension);
        const filePath = path.join(eventsDir, fileName);
        fs.writeFileSync(filePath, '// Swift test');
      });

      // Perform cleanup
      cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);

      // Verify deleted file doesn't exist
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.swift'))).toBe(
        false,
      );
      // Verify remaining file still exists
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.swift'))).toBe(
        true,
      );
    });

    it('should not delete files for events in both lists', () => {
      const eventsDir = path.join(tempDir, 'AvoEvents');
      fs.mkdirSync(eventsDir, { recursive: true });

      const oldEvents = ['EventClicked'];
      const newEvents = ['EventClicked'];
      const extension = '.ts';

      const filePath = path.join(eventsDir, 'eventClicked.ts');
      fs.writeFileSync(filePath, '// test');

      // Perform cleanup
      cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);

      // Verify file still exists
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should not throw when file does not exist', () => {
      const eventsDir = path.join(tempDir, 'AvoEvents');
      fs.mkdirSync(eventsDir, { recursive: true });

      const oldEvents = ['EventDeleted'];
      const newEvents = [];
      const extension = '.ts';

      // Should not throw when file doesn't exist
      expect(() => {
        cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);
      }).not.toThrow();
    });

    it('should handle empty old list (no deletions)', () => {
      const eventsDir = path.join(tempDir, 'AvoEvents');
      fs.mkdirSync(eventsDir, { recursive: true });

      const oldEvents: string[] = [];
      const newEvents = ['EventClicked'];
      const extension = '.ts';

      // Should not throw
      expect(() => {
        cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);
      }).not.toThrow();
    });

    it('should handle empty new list (deletes all old events)', () => {
      const eventsDir = path.join(tempDir, 'AvoEvents');
      fs.mkdirSync(eventsDir, { recursive: true });

      const oldEvents = ['EventClicked', 'EventViewed'];
      const newEvents: string[] = [];
      const extension = '.ts';

      // Create files
      oldEvents.forEach((eventName) => {
        const fileName = eventNameToFileName(eventName, extension);
        const filePath = path.join(eventsDir, fileName);
        fs.writeFileSync(filePath, '// test');
      });

      // Perform cleanup
      cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);

      // Verify all files deleted
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.ts'))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(eventsDir, 'eventViewed.ts'))).toBe(false);
    });
  });

  describe('Integration test', () => {
    it('should simulate full cleanup flow', () => {
      // Setup: Create a mock file-per-event structure
      const sourcePath = path.join(tempDir, 'Avo.ts');
      const moduleName = 'Avo';
      const eventsDir = getEventsDirectoryPath(sourcePath, moduleName);

      // Create events directory
      fs.mkdirSync(eventsDir, { recursive: true });

      // Create old event files
      const oldEvents = ['EventClicked', 'EventViewed', 'EventDeleted'];
      const extension = '.ts';
      oldEvents.forEach((eventName) => {
        const fileName = eventNameToFileName(eventName, extension);
        const filePath = path.join(eventsDir, fileName);
        fs.writeFileSync(filePath, '// old event');
      });

      // Simulate: New events list (one event removed)
      const newEvents = ['EventClicked', 'EventViewed'];

      // Verify file-per-event mode detection
      const isFilePerEvent = isFilePerEventMode(sourcePath, moduleName);
      expect(isFilePerEvent).toBe(true);

      // Perform cleanup
      cleanupObsoleteEventFiles(eventsDir, oldEvents, newEvents, extension);

      // Verify cleanup results
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.ts'))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.ts'))).toBe(true);
      expect(fs.existsSync(path.join(eventsDir, 'eventViewed.ts'))).toBe(true);
    });
  });
});

describe('Prompt message helpers', () => {
  it('buildFolderMessage includes the provided outputDirExample', () => {
    const result = buildFolderMessage({
      outputDirExample: 'app/src/main/kotlin/analytics',
    });
    expect(result).toContain('app/src/main/kotlin/analytics');
  });

  it('buildFolderMessage falls back to src/analytics when outputDirExample is omitted', () => {
    const result = buildFolderMessage({});
    expect(result).toContain('src/analytics');
  });

  it('buildFilenameMessage mentions avo pull regeneration', () => {
    const result = buildFilenameMessage();
    expect(result).toContain("This file is regenerated on every 'avo pull'");
  });

  it('buildInterfaceFilenameMessage mentions avo pull regeneration', () => {
    const result = buildInterfaceFilenameMessage();
    expect(result).toContain("This file is regenerated on every 'avo pull'");
  });
});

describe('avo.json merge conflict resolution', () => {
  // Both the feature's own key and an UNRELATED unknown key are deliberately placed on
  // the HEAD side of the conflict: the resolution keeps HEAD-side top-level state, so
  // that is the only side where the drop is observable.
  const conflictedAvoJson = [
    '{',
    '  "avo": { "version": 3 },',
    '  "schema": { "id": "schema-1", "name": "Test Workspace" },',
    '<<<<<<< HEAD',
    '  "branch": { "id": "branch-head", "name": "head-branch" },',
    '  "libraryInterfaceFileFilter": "events-only",',
    '  "libraryInterfaceSharedModule": "@acme/analytics",',
    '  "teamNote": "shared interface repo",',
    // Committed by any repo that has ever run `avo pull -f` — this repo's own
    // avo.json on main carries it.
    '  "force": true,',
    '  "forceFeatures": "AddUserPropertiesParameterInLogEvent",',
    '=======',
    '  "branch": { "id": "branch-incoming", "name": "incoming-branch" },',
    '>>>>>>> incoming',
    '  "sources": [',
    '    {',
    '      "id": "source-1",',
    '      "name": "Web",',
    '      "path": "src/Avo.ts",',
    '      "actionId": "action-1",',
    '      "branchId": "branch-head",',
    '      "updatedAt": "2026-08-01T00:00:00.000Z",',
    '      "libraryInterfaceFileFilter": "interface-only"',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  const parseConflictSides = (file: string) => {
    const [headFile, incomingFile] = extractConflictingFiles(file);
    return [JSON.parse(headFile), JSON.parse(incomingFile)];
  };

  describe('extractConflictingFiles', () => {
    it('splits a conflicted avo.json into two parseable sides', () => {
      const [head, incoming] = parseConflictSides(conflictedAvoJson);

      expect(head.branch.id).toBe('branch-head');
      expect(incoming.branch.id).toBe('branch-incoming');
      expect(head.libraryInterfaceFileFilter).toBe('events-only');
      expect(incoming.libraryInterfaceFileFilter).toBeUndefined();
    });
  });

  describe('buildResolvedAvoJson', () => {
    it('preserves unknown top-level state, not just the keys it knows about', () => {
      const [head] = parseConflictSides(conflictedAvoJson);

      const resolved = buildResolvedAvoJson(head) as Record<string, any>;

      // The unrelated key is the real assertion: it locks the class of behaviour
      // (unknown top-level state survives) rather than one field, so a whitelist
      // that merely gained `libraryInterfaceFileFilter` would not satisfy it.
      expect(resolved.teamNote).toBe('shared interface repo');
      expect(resolved.libraryInterfaceFileFilter).toBe('events-only');
    });

    it('takes avo, schema, branch and sources from HEAD', () => {
      const [head] = parseConflictSides(conflictedAvoJson);

      const resolved = buildResolvedAvoJson(head) as Record<string, any>;

      expect(resolved.avo).toEqual({ version: 3 });
      expect(resolved.schema).toEqual({
        id: 'schema-1',
        name: 'Test Workspace',
      });
      expect(resolved.branch).toEqual({
        id: 'branch-head',
        name: 'head-branch',
      });
      expect(resolved.sources).toEqual(head.sources);
    });

    // `force` and `forceFeatures` are per-invocation flags, not settings:
    // loadAvoJsonOrInit stamps them into the in-memory json and codegen persists
    // it, so they end up committed. Carrying them out of conflict resolution
    // turns the follow-up main-pull into an unprompted force-merge, which
    // discards changes to items archived on main.
    it('drops a committed force and forceFeatures', () => {
      const [head] = parseConflictSides(conflictedAvoJson);
      expect(head.force).toBe(true);
      expect(head.forceFeatures).toBe('AddUserPropertiesParameterInLogEvent');

      const resolved = buildResolvedAvoJson(head) as Record<string, any>;

      expect('force' in resolved).toBe(false);
      expect('forceFeatures' in resolved).toBe(false);
      // Still a spread, not a whitelist: unknown state must survive alongside.
      expect(resolved.teamNote).toBe('shared interface repo');
    });

    it('keeps a per-source key on a HEAD source', () => {
      const [head] = parseConflictSides(conflictedAvoJson);

      const resolved = buildResolvedAvoJson(head) as Record<string, any>;

      expect(resolved.sources[0].libraryInterfaceFileFilter).toBe(
        'interface-only',
      );
    });
  });

  describe('findUnresolvableAvoJsonConflict', () => {
    it('returns null when the conflict is automatically resolvable', () => {
      const [head, incoming] = parseConflictSides(conflictedAvoJson);

      expect(findUnresolvableAvoJsonConflict(head, incoming)).toBeNull();
    });

    // sources is optional: an initialised repo that has not added a source yet has
    // no key at all, and mapping over it directly threw a TypeError.
    it('resolves when neither side has a sources key', () => {
      const head: any = {
        avo: { version: 2 },
        schema: { id: 'schema-1', name: 'Test' },
        branch: { id: 'master', name: 'main' },
      };
      const incoming: any = {
        avo: { version: 2 },
        schema: { id: 'schema-1', name: 'Test' },
        branch: { id: 'feature', name: 'feature' },
      };

      expect(findUnresolvableAvoJsonConflict(head, incoming)).toBeNull();
    });

    it('bails out on a mismatched avo version', () => {
      const [head, incoming] = parseConflictSides(conflictedAvoJson);
      incoming.avo = { version: 2 };

      expect(findUnresolvableAvoJsonConflict(head, incoming)).toBe(
        "Could not automatically resolve merge conflicts in avo.json. Resolve merge conflicts in avo.json before running 'avo pull' again.",
      );
    });

    it('bails out on a mismatched schema id', () => {
      const [head, incoming] = parseConflictSides(conflictedAvoJson);
      incoming.schema = { id: 'schema-2', name: 'Other Workspace' };

      expect(findUnresolvableAvoJsonConflict(head, incoming)).toBe(
        "Could not automatically resolve merge conflicts in avo.json. Resolve merge conflicts in avo.json before running 'avo pull' again.",
      );
    });

    it('bails out on a conflicted sources list', () => {
      const [head, incoming] = parseConflictSides(conflictedAvoJson);
      incoming.sources = [{ ...incoming.sources[0], id: 'source-2' }];

      expect(findUnresolvableAvoJsonConflict(head, incoming)).toBe(
        "Could not automatically resolve merge conflicts in avo.json. Resolve merge conflicts in sources list in avo.json before running 'avo pull' again.",
      );
    });

    // The filter is a generation-scope setting — a mismatch is NOT a structural
    // conflict and must never hard-block the pull.
    it('does NOT bail on a libraryInterfaceFileFilter mismatch', () => {
      const [head, incoming] = parseConflictSides(conflictedAvoJson);
      incoming.libraryInterfaceFileFilter = 'interface-only';
      expect(head.libraryInterfaceFileFilter).toBe('events-only');

      expect(findUnresolvableAvoJsonConflict(head, incoming)).toBeNull();
    });
  });

  describe('buildAvoJsonFilterMismatchWarning', () => {
    it('returns null when both sides agree', () => {
      expect(
        buildAvoJsonFilterMismatchWarning(
          { libraryInterfaceFileFilter: 'events-only' },
          { libraryInterfaceFileFilter: 'events-only' },
        ),
      ).toBeNull();
    });

    // Both undefined counts as agreement — neither branch set the key.
    it('returns null when both sides are unset', () => {
      expect(buildAvoJsonFilterMismatchWarning({}, {})).toBeNull();
    });

    it('names the kept HEAD value and the discarded incoming value', () => {
      const message = buildAvoJsonFilterMismatchWarning(
        { libraryInterfaceFileFilter: 'events-only' },
        { libraryInterfaceFileFilter: 'interface-only' },
      );

      expect(message).toContain("kept libraryInterfaceFileFilter 'events-only'");
      expect(message).toContain("incoming had 'interface-only'");
    });

    // Absent on either side means 'all' at generation time, so the warning must
    // display 'all' rather than 'undefined' when a side has no key.
    it("labels an absent side as 'all'", () => {
      const missingHead = buildAvoJsonFilterMismatchWarning(
        {},
        { libraryInterfaceFileFilter: 'events-only' },
      );
      expect(missingHead).toContain("kept libraryInterfaceFileFilter 'all'");
      expect(missingHead).toContain("incoming had 'events-only'");

      const missingIncoming = buildAvoJsonFilterMismatchWarning(
        { libraryInterfaceFileFilter: 'events-only' },
        {},
      );
      expect(missingIncoming).toContain("kept libraryInterfaceFileFilter 'events-only'");
      expect(missingIncoming).toContain("incoming had 'all'");
    });
  });
});

describe('libraryInterfaceFileFilter', () => {
  const baseJson = () => ({
    avo: { version: 3 },
    schema: { id: 'schema-1', name: 'Test Workspace' },
    branch: { id: 'master', name: 'main' },
    sources: [
      {
        id: 'source-1',
        name: 'Web',
        path: 'src/Avo.ts',
        interfacePath: 'src/Avo.ts',
        actionId: 'action-1',
        branchId: 'master',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'source-2',
        name: 'iOS',
        path: 'Sources/Avo.swift',
        interfacePath: 'Sources/AvoLibraryInterface.swift',
        actionId: 'action-2',
        branchId: 'master',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  });

  describe('parseLibraryInterfaceFileFilter', () => {
    it('accepts every supported value', () => {
      expect(LIBRARY_INTERFACE_FILE_FILTER_VALUES).toEqual([
        'interface-only',
        'events-only',
        'all',
      ]);
      LIBRARY_INTERFACE_FILE_FILTER_VALUES.forEach((value) => {
        expect(parseLibraryInterfaceFileFilter(value)).toBe(value);
      });
    });

    it('rejects an unsupported value with the documented message', () => {
      expect(() => parseLibraryInterfaceFileFilter('interfaceonly')).toThrow(
        /must be one of interface-only, events-only, all/,
      );
    });
  });

  describe('resolveLibraryInterfaceFileFilter', () => {
    it('prefers the per-run flag', () => {
      expect(
        resolveLibraryInterfaceFileFilter({
          flag: 'interface-only',
          source: { libraryInterfaceFileFilter: 'events-only' },
          json: { libraryInterfaceFileFilter: 'all' },
        }),
      ).toBe('interface-only');
    });

    it('falls back to the per-source override', () => {
      expect(
        resolveLibraryInterfaceFileFilter({
          flag: undefined,
          source: { libraryInterfaceFileFilter: 'events-only' },
          json: { libraryInterfaceFileFilter: 'all' },
        }),
      ).toBe('events-only');
    });

    it('falls back to the top-level value', () => {
      expect(
        resolveLibraryInterfaceFileFilter({
          flag: undefined,
          source: {},
          json: { libraryInterfaceFileFilter: 'interface-only' },
        }),
      ).toBe('interface-only');
    });

    it("defaults to 'all'", () => {
      expect(
        resolveLibraryInterfaceFileFilter({
          flag: undefined,
          source: {},
          json: {},
        }),
      ).toBe('all');
    });
  });

  describe('resolveLibraryInterfaceSharedModule', () => {
    it('prefers the per-source value', () => {
      expect(
        resolveLibraryInterfaceSharedModule({
          source: { libraryInterfaceSharedModule: 'com.acme.analytics' },
          json: { libraryInterfaceSharedModule: '@acme/analytics' },
        }),
      ).toBe('com.acme.analytics');
    });

    it('falls back to the top-level value', () => {
      expect(
        resolveLibraryInterfaceSharedModule({
          source: {},
          json: { libraryInterfaceSharedModule: '@acme/analytics' },
        }),
      ).toBe('@acme/analytics');
    });

    it('is undefined when neither level sets it', () => {
      expect(
        resolveLibraryInterfaceSharedModule({ source: {}, json: {} }),
      ).toBeUndefined();
    });

    // The value is a handle consumed verbatim server-side — a Kotlin package or a
    // TS module specifier. The CLI has no language field and must derive nothing.
    it('returns the value verbatim, whatever shape it has', () => {
      ['../../shell/AvoLibrary', 'com.acme.analytics', '@acme/analytics'].forEach(
        (value) => {
          expect(
            resolveLibraryInterfaceSharedModule({
              source: { libraryInterfaceSharedModule: value },
              json: {},
            }),
          ).toBe(value);
        },
      );
    });
  });

  describe('buildPullRequestBody', () => {
    it('resolves each source independently in one request', () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      json.sources[0].libraryInterfaceFileFilter = 'interface-only';

      const body = buildPullRequestBody(json, json.sources);

      expect(body.sources[0].libraryInterfaceFileFilter).toBe('interface-only');
      expect(body.sources[1].libraryInterfaceFileFilter).toBe('events-only');
    });

    it('sends exactly the five per-source fields', () => {
      const json: any = baseJson();
      json.sources[0].libraryInterfaceSharedModule = '@acme/analytics';

      const body = buildPullRequestBody(json, json.sources);

      expect(Object.keys(body.sources[0])).toEqual([
        'id',
        'path',
        'interfacePath',
        'libraryInterfaceFileFilter',
        'libraryInterfaceSharedModule',
      ]);
      expect(body.sources[0]).toEqual({
        id: 'source-1',
        path: 'src/Avo.ts',
        interfacePath: 'src/Avo.ts',
        libraryInterfaceFileFilter: 'all',
        libraryInterfaceSharedModule: '@acme/analytics',
      });
    });

    // Omitted rather than sent as "" — the server reads the key's presence, and an
    // empty string is a handle that would reach the generators verbatim.
    it('omits libraryInterfaceSharedModule entirely when unset', () => {
      const json: any = baseJson();

      const body = buildPullRequestBody(json, json.sources);

      expect(Object.keys(body.sources[0])).toEqual([
        'id',
        'path',
        'interfacePath',
        'libraryInterfaceFileFilter',
      ]);
      expect('libraryInterfaceSharedModule' in body.sources[0]).toBe(false);
    });

    it('forwards the module raw, with no client-side derivation', () => {
      const json: any = baseJson();
      // A relative TS specifier: the CLI must not resolve, normalise or re-root it.
      json.libraryInterfaceSharedModule = '../../shell/AvoLibrary';
      json.sources[1].libraryInterfaceSharedModule = 'com.acme.analytics';

      const body = buildPullRequestBody(json, json.sources);

      expect(body.sources[0].libraryInterfaceSharedModule).toBe(
        '../../shell/AvoLibrary',
      );
      expect(body.sources[1].libraryInterfaceSharedModule).toBe(
        'com.acme.analytics',
      );
    });

    it('leaves the top-level body fields unchanged', () => {
      const json: any = baseJson();
      json.force = true;
      json.forceFeatures = 'a,b';

      const body = buildPullRequestBody(json, json.sources);

      expect(Object.keys(body)).toEqual([
        'schemaId',
        'branchId',
        'sources',
        'force',
        'forceFeatures',
      ]);
      expect(body.schemaId).toBe('schema-1');
      expect(body.branchId).toBe('master');
      expect(body.force).toBe(true);
      expect(body.forceFeatures).toBe('a,b');
    });

    it('applies the per-run override to every source in the run', () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      json.sources[0].libraryInterfaceFileFilter = 'all';

      const body = buildPullRequestBody(json, json.sources, 'interface-only');

      expect(
        body.sources.map((s: any) => s.libraryInterfaceFileFilter),
      ).toEqual(['interface-only', 'interface-only']);
    });

    it("resolves from avo.json when no override is passed, as the 'avo conflict' path does", () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';

      const body = buildPullRequestBody(json, json.sources);

      expect(
        body.sources.map((s: any) => s.libraryInterfaceFileFilter),
      ).toEqual(['events-only', 'events-only']);
    });
  });

  describe('validateAvoJson rejects a malformed persisted value', () => {
    useTempCwd();

    // validateAvoJson throws synchronously, as it already does for an outdated CLI;
    // every production call site sits inside a .then, so the throw surfaces as a
    // rejection there — asserted by the loadAvoJson* tests below.
    it('rejects a malformed top-level value', () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'interfaceonly';

      expect(() => validateAvoJson(json)).toThrow(
        /must be one of interface-only, events-only, all/,
      );
    });

    it('rejects a malformed per-source value', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterfaceFileFilter = 'eventsonly';

      expect(() => validateAvoJson(json)).toThrow(
        /must be one of interface-only, events-only, all/,
      );
    });

    it('surfaces on a non-pull command path (loadAvoJson)', async () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'interfaceonly';
      fs.writeFileSync('avo.json', JSON.stringify(json, null, 2));

      await expect(loadAvoJson()).rejects.toThrow(
        /must be one of interface-only, events-only, all/,
      );
    });

    it('surfaces on the pull command path (loadAvoJsonOrInit)', async () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'interfaceonly';
      fs.writeFileSync('avo.json', JSON.stringify(json, null, 2));

      await expect(
        loadAvoJsonOrInit({
          argv: {},
          skipInit: false,
          skipPullMaster: false,
        }),
      ).rejects.toThrow(/must be one of interface-only, events-only, all/);
    });

    it('accepts a well-formed value on both levels', async () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      json.sources[0].libraryInterfaceFileFilter = 'interface-only';

      const validated: any = await validateAvoJson(json);
      expect(validated.libraryInterfaceFileFilter).toBe('events-only');
      expect(validated.sources[0].libraryInterfaceFileFilter).toBe(
        'interface-only',
      );
    });
  });

  describe('libraryInterface.publicItems', () => {
    it('forwards a valid per-source list on pull, as the flat wire key', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = {
        publicItems: ['AvoTypes.Platform', 'initAvo'],
      };

      const body = buildPullRequestBody(json, json.sources);

      expect(body.sources[1].libraryInterfacePublicItems).toEqual([
        'AvoTypes.Platform',
        'initAvo',
      ]);
      expect('libraryInterfacePublicItems' in body.sources[0]).toBe(false);
    });

    it('omits the key entirely when unset', () => {
      const json: any = baseJson();

      const body = buildPullRequestBody(json, json.sources);

      expect(
        body.sources.map((s: any) => 'libraryInterfacePublicItems' in s),
      ).toEqual([false, false]);
    });

    it('accepts a valid list in validateAvoJson', async () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { publicItems: ['LoginSuccessEvent'] };

      const validated: any = await validateAvoJson(json);
      expect(validated.sources[1].libraryInterface.publicItems).toEqual([
        'LoginSuccessEvent',
      ]);
    });

    it.each([
      ['a non-array', 'initAvo'],
      ['an array with a non-string', ['initAvo', 42]],
      ['an array with an empty string', ['initAvo', '']],
    ])('rejects %s, naming the source', (_label, value) => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { publicItems: value };

      expect(() => validateAvoJson(json)).toThrow(
        /Invalid libraryInterface.publicItems on source 'iOS'.*must be an array of non-empty strings/,
      );
    });

    it.each([
      ['a whitespace-only entry', ['initAvo', '   '], 1, "'   '"],
      ['an entry with leading whitespace', [' initAvo'], 0, "' initAvo'"],
      [
        'an entry with trailing whitespace',
        ['A', 'B', 'initAvo\t'],
        2,
        "'initAvo\t'",
      ],
    ])('rejects %s, naming the bad entry', (_label, value, index, shown) => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { publicItems: value };

      expect(() => validateAvoJson(json)).toThrow(
        `Invalid libraryInterface.publicItems on source 'iOS' in avo.json — must be an array of non-empty strings without surrounding whitespace; entry ${index} is ${shown}`,
      );
    });

    it('rejects a list longer than 1000 entries, giving the count', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = {
        publicItems: Array.from({ length: 1001 }, (_, index) => `Item${index}`),
      };

      expect(() => validateAvoJson(json)).toThrow(
        "Invalid libraryInterface.publicItems on source 'iOS' in avo.json — lists 1001 entries; at most 1000 are allowed",
      );
    });

    it('accepts a list of exactly 1000 entries', async () => {
      const json: any = baseJson();
      const items = Array.from({ length: 1000 }, (_, index) => `Item${index}`);
      json.sources[1].libraryInterface = { publicItems: items };

      const validated: any = await validateAvoJson(json);
      expect(validated.sources[1].libraryInterface.publicItems).toEqual(items);
    });

    it('names a non-string entry by its index', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { publicItems: ['initAvo', 42] };

      expect(() => validateAvoJson(json)).toThrow(/entry 1 is 42$/);
    });
  });

  describe('nested libraryInterface settings', () => {
    it('resolves nested top-level settings like the flat keys, sending flat wire keys', () => {
      const json: any = baseJson();
      json.libraryInterface = {
        fileFilter: 'events-only',
        sharedModule: '@acme/analytics',
      };

      const body = buildPullRequestBody(json, json.sources);

      expect(
        body.sources.map((s: any) => [
          s.libraryInterfaceFileFilter,
          s.libraryInterfaceSharedModule,
        ]),
      ).toEqual([
        ['events-only', '@acme/analytics'],
        ['events-only', '@acme/analytics'],
      ]);
    });

    it('lets a nested per-source setting override a flat top-level one', () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      json.libraryInterfaceSharedModule = '@acme/analytics';
      json.sources[1].libraryInterface = {
        fileFilter: 'interface-only',
        sharedModule: 'com.acme.analytics',
      };

      const body = buildPullRequestBody(json, json.sources);

      expect(
        body.sources.map((s: any) => [
          s.libraryInterfaceFileFilter,
          s.libraryInterfaceSharedModule,
        ]),
      ).toEqual([
        ['events-only', '@acme/analytics'],
        ['interface-only', 'com.acme.analytics'],
      ]);
    });

    it('lets the per-run flag override a nested setting', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { fileFilter: 'events-only' };

      const body = buildPullRequestBody(json, json.sources, 'all');

      expect(body.sources[1].libraryInterfaceFileFilter).toBe('all');
    });

    it('accepts nested settings at both levels in validateAvoJson', async () => {
      const json: any = baseJson();
      json.libraryInterface = { fileFilter: 'events-only' };
      json.sources[1].libraryInterface = {
        fileFilter: 'interface-only',
        sharedModule: 'com.acme.analytics',
        publicItems: ['initAvo'],
      };

      const validated: any = await validateAvoJson(json);
      expect(validated.libraryInterface).toEqual({ fileFilter: 'events-only' });
      expect(validated.sources[1].libraryInterface).toEqual(
        json.sources[1].libraryInterface,
      );
    });

    it.each([
      ['libraryInterfaceFileFilter', 'events-only'],
      ['libraryInterfaceSharedModule', '@acme/analytics'],
    ])(
      'rejects the nested object next to a flat %s at the top level',
      (key, value) => {
        const json: any = baseJson();
        json.libraryInterface = { fileFilter: 'events-only' };
        json[key] = value;

        expect(() => validateAvoJson(json)).toThrow(
          `Set either libraryInterface or ${key} in avo.json, not both`,
        );
      },
    );

    it('rejects the nested object next to a flat key on the same source', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { fileFilter: 'events-only' };
      json.sources[1].libraryInterfaceFileFilter = 'events-only';

      expect(() => validateAvoJson(json)).toThrow(
        "Set either libraryInterface or libraryInterfaceFileFilter on source 'iOS' in avo.json, not both",
      );
    });

    it('allows the flat form at one level and the nested form at another', async () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      json.sources[1].libraryInterface = { publicItems: ['initAvo'] };

      await expect(validateAvoJson(json)).resolves.toBeDefined();
    });

    it.each([
      ['a string', 'events-only'],
      ['an array', ['events-only']],
      ['null', null],
    ])('rejects %s in place of the object', (_label, value) => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = value;

      expect(() => validateAvoJson(json)).toThrow(
        "Invalid libraryInterface on source 'iOS' in avo.json — must be an object with fileFilter, sharedModule or publicItems",
      );
    });

    it('rejects an unknown key, naming it and the allowed ones', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { filter: 'events-only' };

      expect(() => validateAvoJson(json)).toThrow(
        "Unknown key 'filter' in libraryInterface on source 'iOS' in avo.json — allowed keys are fileFilter, sharedModule, publicItems",
      );
    });

    it('rejects publicItems at the top level, since it is per source', () => {
      const json: any = baseJson();
      json.libraryInterface = { publicItems: ['initAvo'] };

      expect(() => validateAvoJson(json)).toThrow(
        "Unknown key 'publicItems' in libraryInterface in avo.json — allowed keys are fileFilter, sharedModule",
      );
    });

    it('rejects an invalid nested fileFilter under its nested name', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterface = { fileFilter: 'interfaceonly' };

      expect(() => validateAvoJson(json)).toThrow(
        "Invalid libraryInterface.fileFilter 'interfaceonly' on source 'iOS' in avo.json",
      );
    });

    it('rejects a nested sharedModule that is not a non-empty string', () => {
      const json: any = baseJson();
      json.libraryInterface = { sharedModule: 42 };

      expect(() => validateAvoJson(json)).toThrow(
        'Invalid libraryInterface.sharedModule in avo.json — must be a non-empty string',
      );
    });

    it.each([
      ['an empty string', ''],
      ['a number', 42],
    ])(
      'rejects %s as a flat libraryInterfaceSharedModule, like the nested one',
      (_label, value) => {
        const json: any = baseJson();
        json.sources[1].libraryInterfaceSharedModule = value;

        expect(() => validateAvoJson(json)).toThrow(
          "Invalid libraryInterfaceSharedModule on source 'iOS' in avo.json — must be a non-empty string",
        );
      },
    );

    // publicItems never shipped in the flat form, so a flat key is a mistake to
    // report rather than a value to forward or silently drop.
    it('rejects a flat libraryInterfacePublicItems, pointing at the nested key', () => {
      const json: any = baseJson();
      json.sources[1].libraryInterfacePublicItems = ['initAvo'];

      expect(() => validateAvoJson(json)).toThrow(
        "libraryInterfacePublicItems on source 'iOS' in avo.json is not supported — set libraryInterface.publicItems instead",
      );
    });

    it('keeps the nested object through a branch switch and conflict resolution', () => {
      const json: any = baseJson();
      json.libraryInterface = { fileFilter: 'events-only' };
      json.sources[1].libraryInterface = { publicItems: ['initAvo'] };

      const switched: any = applyBranchToAvoJson(json, {
        id: 'branch-1',
        name: 'feature',
      });
      const resolved: any = buildResolvedAvoJson(json);

      expect([
        switched.libraryInterface,
        switched.sources[1].libraryInterface,
        resolved.libraryInterface,
        resolved.sources[1].libraryInterface,
      ]).toEqual([
        { fileFilter: 'events-only' },
        { publicItems: ['initAvo'] },
        { fileFilter: 'events-only' },
        { publicItems: ['initAvo'] },
      ]);
    });

    it('compares nested and flat filters alike when warning about a merge mismatch', () => {
      expect([
        buildAvoJsonFilterMismatchWarning(
          { libraryInterface: { fileFilter: 'events-only' } } as any,
          { libraryInterfaceFileFilter: 'events-only' },
        ),
        buildAvoJsonFilterMismatchWarning(
          { libraryInterface: { fileFilter: 'events-only' } } as any,
          { libraryInterface: { fileFilter: 'interface-only' } } as any,
        ),
      ]).toEqual([
        null,
        "avo.json conflict: kept libraryInterface.fileFilter 'events-only' from your branch (incoming had 'interface-only')",
      ]);
    });

    it('names the setting as the kept side writes it, else as the incoming side does', () => {
      expect([
        buildAvoJsonFilterMismatchWarning(
          { libraryInterfaceFileFilter: 'events-only' },
          { libraryInterface: { fileFilter: 'interface-only' } } as any,
        ),
        buildAvoJsonFilterMismatchWarning({}, {
          libraryInterface: { fileFilter: 'interface-only' },
        } as any),
      ]).toEqual([
        "avo.json conflict: kept libraryInterfaceFileFilter 'events-only' from your branch (incoming had 'interface-only')",
        "avo.json conflict: kept libraryInterface.fileFilter 'all' from your branch (incoming had 'interface-only')",
      ]);
    });
  });

  describe('persistence across write paths', () => {
    useTempCwd();

    it('applyBranchToAvoJson keeps the top-level setting across a checkout', () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'interface-only';
      json.teamNote = 'shared interface repo';

      const next: any = applyBranchToAvoJson(json, {
        id: 'branch-1',
        name: 'feature',
      });

      expect(next.branch).toEqual({ id: 'branch-1', name: 'feature' });
      expect(next.libraryInterfaceFileFilter).toBe('interface-only');
      expect(next.teamNote).toBe('shared interface repo');
    });

    it('codegen preserves per-source state and never writes the per-run flag back', async () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      json.sources[0].libraryInterfaceFileFilter = 'events-only';
      json.sources[0].teamOwner = 'growth';
      json.sources.pop();

      // The override travels as a pull() argument, so it is absent from the json
      // codegen deep-copies and persists.
      const body = buildPullRequestBody(json, json.sources, 'interface-only');
      expect(body.sources[0].libraryInterfaceFileFilter).toBe('interface-only');

      await codegen(json, {
        schema: json.schema,
        sources: [
          {
            id: 'source-1',
            actionId: 'action-2',
            name: 'Web',
            branchId: 'master',
            updatedAt: '2026-08-02T00:00:00.000Z',
            code: [{ path: 'src/Avo.ts', content: '// generated' }],
          },
        ],
        warnings: [],
        success: [],
        errors: '',
      });

      const written = JSON.parse(fs.readFileSync('avo.json', 'utf8'));

      expect(written.libraryInterfaceFileFilter).toBe('events-only');
      expect(written.sources[0].libraryInterfaceFileFilter).toBe('events-only');
      // Unknown per-source state survives too, locking the `...source` spread
      // rather than this one field.
      expect(written.sources[0].teamOwner).toBe('growth');
      expect(JSON.stringify(written)).not.toContain('interface-only');
    });
  });

  describe('applyPullResult', () => {
    useTempCwd();

    it('runs codegen when the response is ok', async () => {
      const json: any = baseJson();
      const runCodegen = jest.fn<(a: any, b: any) => void>();
      const retry = jest.fn<(a: any, b: any, c: any) => void>();
      const result: any = { ok: true, sources: [] };

      await applyPullResult('Web', json, result, 'events-only', {
        runCodegen,
        retry,
      });

      expect(runCodegen).toHaveBeenCalledWith(json, result);
      expect(retry).not.toHaveBeenCalled();
    });

    // codegen resolves only once avo.json and every generated file are on disk.
    // Discarding its promise let pull() resolve before those writes finished and
    // hid rejections from the pull command's own .catch analytics path (they
    // still landed on the process-wide unhandledRejection handler, but with a
    // bare process.exit(1) that loses per-command context).
    it("awaits an async runCodegen before resolving", async () => {
      const json: any = baseJson();
      let resolved = false;
      let releaseCodegen: () => void = () => {};
      const codegenDone = new Promise<void>((resolve) => {
        releaseCodegen = resolve;
      });
      const runCodegen = jest.fn(() =>
        codegenDone.then(() => {
          resolved = true;
        }),
      );

      const applyPromise = applyPullResult(
        'Web',
        json,
        { ok: true, sources: [] } as any,
        undefined,
        { runCodegen },
      );

      // A microtask turn — enough for a discarded promise's caller to resolve.
      await Promise.resolve();
      expect(resolved).toBe(false);

      releaseCodegen();
      await applyPromise;

      expect(resolved).toBe(true);
    });

    it('surfaces a runCodegen rejection to the caller', async () => {
      const json: any = baseJson();
      const runCodegen = jest.fn(() =>
        Promise.reject(new Error('codegen failed to write avo.json')),
      );

      await expect(
        applyPullResult(
          'Web',
          json,
          { ok: true, sources: [] } as any,
          undefined,
          { runCodegen },
        ),
      ).rejects.toThrow('codegen failed to write avo.json');
    });

    it('writes nothing and forwards the override to the post-checkout retry when the branch is closed', async () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      fs.writeFileSync('avo.json', JSON.stringify(json, null, 2));
      const before = fs.readFileSync('avo.json', 'utf8');
      const retry = jest.fn<(a: any, b: any, c: any) => void>();

      await applyPullResult(
        'Web',
        json,
        {
          ok: false,
          branchName: 'feature',
          reason: 'closed',
          closedAt: new Date().toISOString(),
        } as any,
        'interface-only',
        { retry },
      );

      expect(retry).toHaveBeenCalledWith('Web', json, 'interface-only');
      expect(fs.readFileSync('avo.json', 'utf8')).toBe(before);
      expect(fs.readdirSync('.')).toEqual(['avo.json']);
    });
  });
});

describe('avo init and libraryInterfaceFileFilter', () => {
  const workspace = { id: 'schema-1', name: 'Test Workspace' };

  let previousCi: string | undefined;

  beforeEach(() => {
    previousCi = process.env.CI;
    delete process.env.CI;
  });

  afterEach(() => {
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
  });

  const fetchWorkspaces =
    (...workspaces: object[]) =>
    () =>
      Promise.resolve({ workspaces } as any);

  // The info line is the only discovery surface now that init does not prompt —
  // the way to enable the feature is to edit avo.json, so the line must name
  // both settings and where they live.
  describe('buildLibraryInterfaceFileFilterInfoLine', () => {
    it('names both settings and their values and where they go', () => {
      const line = buildLibraryInterfaceFileFilterInfoLine();

      expect(line).toContain('libraryInterface');
      expect(line).toContain('fileFilter');
      expect(line).toContain('sharedModule');
      expect(line).not.toContain('libraryInterfaceFileFilter');
      expect(line).toContain('interface-only');
      expect(line).toContain('events-only');
      expect(line).toContain('all');
      expect(line).toContain('avo.json');
    });
  });

  // Locked-in decision: init leaves both keys absent (absent means 'all') and
  // prints the info line — no prompt, no --flag, no --pre-answer. Advanced
  // setup, few users reach it; the cost of prompting every user was worse than
  // the discoverability cost of not prompting.
  describe('init() never prompts for the split-mode settings', () => {
    it('single-workspace: no prompt, omits both keys', async () => {
      const promptFn = jest.fn() as any;
      const reportInfo = jest.fn<(text: string) => void>();

      const json: any = await init({
        fetchWorkspaces: fetchWorkspaces(workspace),
        promptFn,
        reportInfo,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect('libraryInterfaceFileFilter' in json).toBe(false);
      expect('libraryInterfaceSharedModule' in json).toBe(false);
      expect('libraryInterface' in json).toBe(false);
      const infoLines = reportInfo.mock.calls.map((c) => String(c[0])).join('\n');
      expect(infoLines).toContain('libraryInterface.fileFilter');
      expect(infoLines).toContain('libraryInterface.sharedModule');
    });

    it('multi-workspace: prompts ONLY for the workspace picker, omits both keys', async () => {
      const otherWorkspace = { id: 'schema-2', name: 'Other Workspace' };
      const promptFn = jest.fn(async (questions: any) => {
        expect(questions[0].name).toBe('schema');
        return { schema: otherWorkspace };
      }) as any;

      const json: any = await init({
        fetchWorkspaces: fetchWorkspaces(workspace, otherWorkspace),
        promptFn,
        reportInfo: () => {},
      });

      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(json.schema.id).toBe('schema-2');
      expect('libraryInterfaceFileFilter' in json).toBe(false);
      expect('libraryInterfaceSharedModule' in json).toBe(false);
    });
  });

  describe('implicit init from the pull path', () => {
    useTempCwd();

    it('completes in CI without prompting when avo.json is missing', async () => {
      const promptFn = jest.fn();
      process.env.CI = 'true';

      const json: any = await loadAvoJsonOrInit({
        argv: { token: 'test-token' },
        skipInit: false,
        skipPullMaster: false,
        initFn: () =>
          init({
            fetchWorkspaces: fetchWorkspaces(workspace),
            promptFn: promptFn as any,
            reportInfo: () => {},
          }),
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(json.schema.id).toBe('schema-1');
      expect('libraryInterfaceFileFilter' in json).toBe(false);
    });
  });
});

describe('stale files from a previous filter', () => {
  describe('collectStaleSuppressedFiles', () => {
    it('keeps only the suppressed paths that exist on disk', () => {
      const exists = (p: string) => p === 'src/AvoLibrary.ts';

      expect(
        collectStaleSuppressedFiles(
          ['src/AvoLibrary.ts', 'src/AvoConfig.ts'],
          exists,
        ),
      ).toEqual(['src/AvoLibrary.ts']);
    });

    it('preserves response order for multiple stale paths', () => {
      expect(
        collectStaleSuppressedFiles(['b.ts', 'a.ts', 'c.ts'], () => true),
      ).toEqual(['b.ts', 'a.ts', 'c.ts']);
    });

    it('returns nothing for an absent or empty suppressedPaths', () => {
      expect(collectStaleSuppressedFiles(undefined, () => true)).toEqual([]);
      expect(collectStaleSuppressedFiles([], () => true)).toEqual([]);
    });
  });

  describe('buildStaleSuppressedFileWarning', () => {
    it('names the file without claiming which side of the split it is', () => {
      const warning = buildStaleSuppressedFileWarning('src/AvoLibrary.ts');

      expect(warning).toContain('[avo] Warning:');
      expect(warning).toContain('src/AvoLibrary.ts');
      expect(warning).toMatch(/no longer generated/i);
      expect(warning).toContain('libraryInterfaceFileFilter');
    });

    // Under interface-only the suppressed files are app/event files, not the
    // interface — wording that names the interface would send a user to delete
    // the wrong file.
    it('uses the same wording for an app-side file', () => {
      const warning = buildStaleSuppressedFileWarning('src/AvoEvents/clicked.ts');

      expect(warning).toContain('src/AvoEvents/clicked.ts');
      expect(warning).not.toContain('shared interface');
    });
  });

  describe('codegen', () => {
    useTempCwd();

    let logSpy: any;

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    const staleWarnings = () =>
      logSpy.mock.calls
        .map((call: unknown[]) => call.join(' '))
        .filter((line: string) => line.includes('[avo] Warning:'));

    const jsonWith = (
      libraryInterfaceFileFilter?: string,
      sourcePath = 'src/Avo.ts',
    ): any => ({
      avo: { version: 3 },
      schema: { id: 'schema-1', name: 'Test Workspace' },
      branch: { id: 'master', name: 'main' },
      ...(libraryInterfaceFileFilter === undefined
        ? {}
        : { libraryInterfaceFileFilter }),
      sources: [
        {
          id: 'source-1',
          name: 'Web',
          path: sourcePath,
          interfacePath: sourcePath,
          actionId: 'action-1',
          branchId: 'master',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const target = (extra: object = {}) => ({
      id: 'source-1',
      actionId: 'action-2',
      name: 'Web',
      branchId: 'master',
      updatedAt: '2026-08-02T00:00:00.000Z',
      code: [{ path: 'src/AvoEvents/eventClicked.ts', content: '// event' }],
      ...extra,
    });

    const result = (extra: object = {}): any => ({
      schema: { id: 'schema-1', name: 'Test Workspace' },
      sources: [target(extra)],
      warnings: [],
      success: [],
      errors: '',
    });

    it('warns about a stale suppressed file and never deletes it', async () => {
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/AvoLibrary.ts', '// stale shared interface');

      await codegen(
        jsonWith('events-only'),
        result({ suppressedPaths: ['src/AvoLibrary.ts'] }),
      );

      const warnings = staleWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('src/AvoLibrary.ts');
      expect(fs.existsSync('src/AvoLibrary.ts')).toBe(true);
      expect(fs.readFileSync('src/AvoLibrary.ts', 'utf8')).toBe(
        '// stale shared interface',
      );
    });

    it('does not warn about a suppressed path that is not on disk', async () => {
      await codegen(
        jsonWith('events-only'),
        result({ suppressedPaths: ['src/AvoLibrary.ts'] }),
      );

      expect(staleWarnings()).toEqual([]);
    });

    // An 'all' run is expressed by the server returning no suppressed paths, not by
    // the CLI re-deciding locally — that is the whole point of the response-driven gate.
    it("does not warn when the response suppressed nothing, as an 'all' run does", async () => {
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/AvoLibrary.ts', '// stale');

      await codegen(jsonWith(undefined), result({ suppressedPaths: [] }));
      expect(staleWarnings()).toEqual([]);

      await codegen(jsonWith(undefined), result());
      expect(staleWarnings()).toEqual([]);
    });

    // Regression: a one-run override leaves avo.json resolving to 'all', so a locally
    // resolved gate would swallow this warning. The response is the only thing that knows.
    it('warns when a per-run override is the reason files were suppressed', async () => {
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/AvoLibrary.ts', '// stale');

      await codegen(
        jsonWith(undefined),
        result({ suppressedPaths: ['src/AvoLibrary.ts'] }),
      );

      expect(staleWarnings()).toHaveLength(1);
    });

    it('does not throw or warn when the response has no suppressedPaths', async () => {
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/AvoLibrary.ts', '// stale');

      await expect(
        codegen(jsonWith('events-only'), result()),
      ).resolves.toBeUndefined();
      expect(staleWarnings()).toEqual([]);
    });

    it('emits one warning line per stale path, in response order', async () => {
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/Avo.ts', '// stale app file');
      fs.writeFileSync('src/AvoConfig.ts', '// stale config');

      await codegen(
        jsonWith('interface-only'),
        result({
          suppressedPaths: ['src/AvoConfig.ts', 'src/Missing.ts', 'src/Avo.ts'],
        }),
      );

      const warnings = staleWarnings();
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('src/AvoConfig.ts');
      expect(warnings[1]).toContain('src/Avo.ts');
    });

    // Two targets pointing at the same shell path is the multi-source client-repo
    // shape (Web + Node both consuming ./shell/AvoLibrary.ts). Warning three times
    // per pull would be noise; the user can only delete each file once.
    it('warns once per stale path even if multiple targets reference it', async () => {
      fs.mkdirSync('src', { recursive: true });
      fs.writeFileSync('src/AvoLibrary.ts', '// stale shared interface');

      const multiSourceJson = jsonWith('events-only');
      multiSourceJson.sources.push({
        ...multiSourceJson.sources[0],
        id: 'source-2',
        name: 'Node',
        path: 'src/AvoNode.ts',
        interfacePath: 'src/AvoNode.ts',
      });

      await codegen(multiSourceJson, {
        schema: { id: 'schema-1', name: 'Test Workspace' },
        sources: [
          target({ suppressedPaths: ['src/AvoLibrary.ts'] }),
          target({
            id: 'source-2',
            code: [{ path: 'src/AvoNodeEvents/eventClicked.ts', content: '// event' }],
            suppressedPaths: ['src/AvoLibrary.ts'],
          }),
        ],
        warnings: [],
        success: [],
        errors: '',
      } as any);

      const warnings = staleWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('src/AvoLibrary.ts');
    });

    it('leaves the per-event directory intact under interface-only', async () => {
      fs.mkdirSync('src/AvoEvents', { recursive: true });
      fs.writeFileSync(
        'src/Avo.ts',
        [
          '// AVOMODULEMAP: "Avo"',
          '// AVOEVENTMAP: ["EventClicked", "EventViewed"]',
        ].join('\n'),
      );
      fs.writeFileSync('src/AvoEvents/eventClicked.ts', '// event');
      fs.writeFileSync('src/AvoEvents/eventViewed.ts', '// event');

      // interface-only means the main file is absent from the response, so the
      // per-event cleanup gate never opens and nothing under AvoEvents/ is touched.
      await codegen(
        jsonWith('interface-only'),
        result({
          code: [{ path: 'src/AvoLibrary.ts', content: '// interface' }],
        }),
      );

      expect(fs.existsSync('src/AvoEvents/eventClicked.ts')).toBe(true);
      expect(fs.existsSync('src/AvoEvents/eventViewed.ts')).toBe(true);
    });
  });
});

describe('buildSourcePaths', () => {
  const cwd = path.resolve('/repo');

  it('puts the interface file in the same folder as the events file', () => {
    expect(
      buildSourcePaths(
        { folder: 'library/src/main/kotlin/sh/avo/library', filename: 'Avo.kt' },
        { interfaceFilename: 'AvoInterface.kt' },
        cwd,
      ),
    ).toEqual({
      path: path.join(
        'library',
        'src',
        'main',
        'kotlin',
        'sh',
        'avo',
        'library',
        'Avo.kt',
      ),
      interfacePath: path.join(
        'library',
        'src',
        'main',
        'kotlin',
        'sh',
        'avo',
        'library',
        'AvoInterface.kt',
      ),
    });
  });

  it('splits a source into two filenames that never diverge in directory', () => {
    const { path: mainPath, interfacePath } = buildSourcePaths(
      { folder: 'app/src/main/kotlin/analytics', filename: 'Avo.kt' },
      { interfaceFilename: 'AvoInterface.kt' },
      cwd,
    );

    expect(path.dirname(mainPath)).toBe(path.dirname(interfacePath));
    expect(path.basename(mainPath)).toBe('Avo.kt');
    expect(path.basename(interfacePath)).toBe('AvoInterface.kt');
  });

  it('reuses the main path when the source cannot have an interface file', () => {
    // canHaveInterfaceFile !== true skips the interface prompt entirely, so
    // moreAnswers comes back empty and there is no second file to place.
    expect(
      buildSourcePaths({ folder: 'src', filename: 'Avo.ts' }, {}, cwd),
    ).toEqual({
      path: path.join('src', 'Avo.ts'),
      interfacePath: path.join('src', 'Avo.ts'),
    });
  });

  it('resolves an absolute folder answer back to a cwd-relative path', () => {
    expect(
      buildSourcePaths(
        { folder: path.join(cwd, 'library'), filename: 'Avo.kt' },
        { interfaceFilename: 'AvoInterface.kt' },
        cwd,
      ),
    ).toEqual({
      path: path.join('library', 'Avo.kt'),
      interfacePath: path.join('library', 'AvoInterface.kt'),
    });
  });
});

describe('resolveInspectorEnv', () => {
  it('defaults to prod, without a warning, when AVO_INSPECTOR_ENV is unset or blank', () => {
    expect(resolveInspectorEnv(undefined)).toEqual({ env: 'prod' });
    expect(resolveInspectorEnv('')).toEqual({ env: 'prod' });
    expect(resolveInspectorEnv('  ')).toEqual({ env: 'prod' });
  });

  it('takes dev, staging and prod in any case', () => {
    expect(resolveInspectorEnv('dev')).toEqual({ env: 'dev' });
    expect(resolveInspectorEnv('DEV')).toEqual({ env: 'dev' });
    expect(resolveInspectorEnv(' Staging ')).toEqual({ env: 'staging' });
    expect(resolveInspectorEnv('prod')).toEqual({ env: 'prod' });
  });

  it('falls back to prod with a warning naming the value for anything else', () => {
    expect(resolveInspectorEnv('development')).toEqual({
      env: 'prod',
      warning:
        "Unknown AVO_INSPECTOR_ENV 'development' — must be one of prod, dev, staging; using prod",
    });
  });
});

// status() is driven in-process: jest.setup.js turns process.exit into a no-op,
// and no auth is needed once avo.json has sources. Each test runs in a project
// folder that is a fresh git repo, with git isolated from the developer's
// machine, so files are listed by git unless a test says otherwise. Output is
// captured through console.log, because spying on the reporter's ESM namespace
// breaks jest-mock for the whole suite.
describe('status', () => {
  const MiB = 1024 * 1024;

  const tempRoot = useIsolatedGit('avo-status-');
  let logSpy: any;
  let exitSpy: any;

  beforeEach(() => {
    const projectFolder = path.join(tempRoot(), 'project');
    fs.mkdirSync(projectFolder);
    process.chdir(projectFolder);
    git('.', 'init', '-q');

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const output = (): string[] =>
    logSpy.mock.calls.map((call: unknown[]) => call.join(' '));

  const statusJson = (sources: any[]): any => ({
    avo: { version: 3 },
    schema: { id: 'schema-1', name: 'Test Workspace' },
    branch: { id: 'master', name: 'main' },
    sources,
  });

  const webSource = { id: 'source-1', name: 'Web', path: 'Avo.ts' };
  const serverSource = {
    id: 'source-2',
    name: 'Server',
    path: 'server/Server.ts',
  };

  const writeFile = (filePath: string, contents: string): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  };

  const writeAvoFile = (filePath: string, eventNames: string[]): void =>
    writeFile(
      filePath,
      `// AVOMODULEMAP:"Avo"\n// AVOEVENTMAP:${JSON.stringify(eventNames)}\n`,
    );

  // Sparse files: the size is real to lstat without writing 10 MiB to disk, and
  // whatever is written first is still there to be found if the file is read.
  const writeFileOfSize = (
    filePath: string,
    contents: string,
    size: number,
  ): void => {
    writeFile(filePath, contents);
    fs.truncateSync(filePath, size);
  };

  const readPaths = (fsSpy: any): string[] =>
    fsSpy.mock.calls.map((call: unknown[]) => call[0]);

  it('reports where each event is used and resolves once it has', async () => {
    writeAvoFile('Avo.ts', ['eventOne', 'eventTwo']);
    writeFile(
      'src/a.ts',
      'Avo.eventOne();\nAvo.eventTwo();\nAvo.eventTwo();\n',
    );
    writeFile('src/b.ts', 'Avo.eventOne();\n');

    await status(undefined, statusJson([webSource]), { verbose: false });

    expect(output()).toEqual([
      'sources\n' +
        '└─ Web (Avo.ts)\n' +
        '   ├─ eventOne\n' +
        '   │  ├─ used in src/a.ts: 1 time\n' +
        '   │  └─ used in src/b.ts: 1 time\n' +
        '   └─ eventTwo\n' +
        '      └─ used in src/a.ts: 2 times\n',
      'info 2 events seen in code',
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  describe('size cap', () => {
    it('never reads an oversized file and warns with a count', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFileOfSize('src/bundle.min.js', 'Avo.eventOne();\n', 15 * MiB);
      const readFileSpy = jest.spyOn(fs, 'readFile');

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(readPaths(readFileSpy)).not.toContain('src/bundle.min.js');
      expect(output()).toContain(
        'warn Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
      );
      expect(output()).toContain(
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      └─ used in src/a.ts: 1 time\n',
      );
    });

    const writeTwoOversizedFiles = (): void => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFileOfSize('src/vendor/bundle.min.js', '', Math.round(14.2 * MiB));
      writeFileOfSize('src/generated.ts', '', 10 * MiB + 1);
    };

    it('counts every oversized file in one warning line', async () => {
      writeTwoOversizedFiles();

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Skipped 2 files over the 10 MiB size cap; run with --verbose to list them.',
      ]);
    });

    it('lists each oversized file with its size in MiB under --verbose', async () => {
      writeTwoOversizedFiles();

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Skipped 2 files over the 10 MiB size cap:\n' +
          'src/generated.ts (10.0 MiB)\n' +
          'src/vendor/bundle.min.js (14.2 MiB)',
      ]);
    });

    it('reads a file of exactly 10 MiB and skips one a byte larger', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFileOfSize('src/at-cap.ts', 'Avo.eventOne();\n', 10 * MiB);
      writeFileOfSize('src/over-cap.ts', 'Avo.eventOne();\n', 10 * MiB + 1);

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output()).toContain(
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      └─ used in src/at-cap.ts: 1 time\n',
      );
      expect(output()).toContain(
        'warn Skipped 1 file over the 10 MiB size cap:\n' +
          'src/over-cap.ts (10.0 MiB)',
      );
    });

    it('never checks or warns about a huge file outside every effective glob', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFileOfSize('assets/video.mp4', '', 50 * MiB);
      const lstatSpy = jest.spyOn(fs, 'lstat');
      const readFileSpy = jest.spyOn(fs, 'readFile');

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(
        readPaths(lstatSpy).filter((filePath) =>
          filePath.endsWith('video.mp4'),
        ),
      ).toEqual([]);
      expect(
        readPaths(readFileSpy).filter((filePath) =>
          filePath.endsWith('video.mp4'),
        ),
      ).toEqual([]);
      expect(output().filter((line) => line.startsWith('warn'))).toEqual([]);
    });

    it('counts a file matched by two sources once', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeAvoFile('server/Server.ts', ['eventTwo']);
      writeFile('src/a.ts', 'Avo.eventOne();\nAvo.eventTwo();\n');
      writeFileOfSize('src/huge.ts', '', 12 * MiB);

      await status(undefined, statusJson([webSource, serverSource]), {
        verbose: true,
      });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Skipped 1 file over the 10 MiB size cap:\n' +
          'src/huge.ts (12.0 MiB)',
      ]);
    });
  });

  // A tracked file that matches an ignore rule is left out of the listed files,
  // as before, but never silently when it would have been analysed.
  describe('tracked-but-ignored files', () => {
    it('warns once, with a count, about tracked files that match an ignore rule', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFile('src/legacy/old.ts', 'Avo.eventOne();\n');
      writeFile('src/legacy/older.ts', 'Avo.eventOne();\n');
      commitAll('.');
      writeFile('.gitignore', 'legacy/\n');

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(output()).toEqual([
        'warn Skipped 2 tracked files that match an ignore rule; run with --verbose to list them.',
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      └─ used in src/a.ts: 1 time\n',
        'info 1 events seen in code',
      ]);
    });

    it('counts only the ones that match an effective glob', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFile('src/legacy/old.ts', 'Avo.eventOne();\n');
      writeFile('src/legacy/notes.md', 'Avo.eventOne();\n');
      writeFile('dist/bundle.css', '');
      commitAll('.');
      writeFile('.gitignore', 'legacy/\ndist/\n');

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Skipped 1 tracked file that matches an ignore rule; run with --verbose to list it.',
      ]);
    });

    it('says nothing when none of them match an effective glob', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFile('dist/bundle.css', '');
      writeFile('docs/notes.md', '');
      commitAll('.');
      writeFile('.gitignore', 'dist/\n*.md\n');

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([]);
    });

    it('lists them under --verbose', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFile('src/legacy/old.ts', '');
      writeFile('src/legacy/older.ts', '');
      commitAll('.');
      writeFile('.gitignore', 'legacy/\n');

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Skipped 2 tracked files that match an ignore rule:\n' +
          'src/legacy/old.ts\n' +
          'src/legacy/older.ts',
      ]);
    });

    it('counts a file matched by two sources once', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeAvoFile('server/Server.ts', ['eventTwo']);
      writeFile('src/a.ts', 'Avo.eventOne();\nAvo.eventTwo();\n');
      writeFile('src/legacy/old.ts', '');
      commitAll('.');
      writeFile('.gitignore', 'legacy/\n');

      await status(undefined, statusJson([webSource, serverSource]), {
        verbose: false,
      });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Skipped 1 tracked file that matches an ignore rule; run with --verbose to list it.',
      ]);
    });
  });

  // git still lists the rest of the project folder, so the run isn't sent to
  // the walker, but a nested repo's files never disappear silently.
  describe('nested repos git cannot list', () => {
    // A submodule whose gitdir is gone: git fails in its folder.
    const addBrokenSubmodule = (submodulePath: string): void => {
      const source = path.join(tempRoot(), path.basename(submodulePath));
      fs.mkdirSync(source);
      git(source, 'init', '-q');
      writeFile(path.join(source, 'lib.ts'), 'Avo.eventOne();\n');
      commitAll(source);
      git(
        '.',
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        source,
        submodulePath,
      );
      fs.rmSync(path.join('.git', 'modules', submodulePath), {
        recursive: true,
        force: true,
      });
    };

    it('warns once, with a count, and leaves the exit code alone', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      addBrokenSubmodule('vendor/broken');

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(output()).toEqual([
        'warn Skipped 1 nested repo that git could not list; run with --verbose to list it.',
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      └─ used in src/a.ts: 1 time\n',
        'info 1 events seen in code',
      ]);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("lists each one with git's reason under --verbose", async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      addBrokenSubmodule('vendor/first');
      addBrokenSubmodule('vendor/second');

      await status(undefined, statusJson([webSource]), { verbose: true });

      // What git says after "not a git repository" varies by version.
      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        expect.stringMatching(
          /^warn Skipped 2 nested repos that git could not list:\nvendor\/first \(not a git repository.*\)\nvendor\/second \(not a git repository.*\)$/,
        ),
      ]);
    });
  });

  // When git can't list, the walker lists the files instead, as it always did,
  // and status says why. Everything after listing works the same.
  describe('falling back to the walker', () => {
    it.each([
      {
        cause: 'outside a git repo',
        setUp: (): void => {
          fs.rmSync('.git', { recursive: true, force: true });
        },
        warning:
          'warn Listed 4 files without git because not a git repository (or any of the parent directories): .git.',
      },
      {
        cause: 'when git is not installed',
        setUp: (): void => {
          // An empty PATH gives a real ENOENT when git is spawned.
          const emptyBin = path.join(tempRoot(), 'empty-bin');
          fs.mkdirSync(emptyBin);
          process.env.PATH = emptyBin;
        },
        warning: 'warn Listed 4 files without git because git was not found.',
      },
    ])(
      'warns once with the reason $cause, and still applies the size cap',
      async ({ setUp, warning }) => {
        writeAvoFile('Avo.ts', ['eventOne']);
        writeAvoFile('server/Server.ts', ['eventTwo']);
        writeFile('src/a.ts', 'Avo.eventOne();\nAvo.eventTwo();\n');
        writeFileOfSize('src/bundle.min.js', 'Avo.eventOne();\n', 11 * MiB);
        setUp();
        const readFileSpy = jest.spyOn(fs, 'readFile');

        await status(undefined, statusJson([webSource, serverSource]), {
          verbose: false,
        });

        expect(readPaths(readFileSpy)).not.toContain('src/bundle.min.js');
        expect(output().filter((line) => line.startsWith('warn'))).toEqual([
          warning,
          'warn Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
        ]);
      },
    );

    it('counts a single listed file in the singular', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      fs.rmSync('.git', { recursive: true, force: true });

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Listed 1 file without git because not a git repository (or any of the parent directories): .git.',
      ]);
    });

    // git's whole error can say more than its first line, such as how to mark
    // a folder with dubious ownership as safe.
    it("adds git's whole error under --verbose", async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      fs.rmSync('.git', { recursive: true, force: true });

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Listed 1 file without git because not a git repository (or any of the parent directories): .git. git said:\n' +
          'fatal: not a git repository (or any of the parent directories): .git',
      ]);
    });

    it('gives only the reason under --verbose when git did not run', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      const emptyBin = path.join(tempRoot(), 'empty-bin');
      fs.mkdirSync(emptyBin);
      process.env.PATH = emptyBin;

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output().filter((line) => line.startsWith('warn'))).toEqual([
        'warn Listed 1 file without git because git was not found.',
      ]);
    });
  });

  describe('exit code', () => {
    it('reports an event used only in an oversized file as missing, with the warning on the same run', async () => {
      writeAvoFile('Avo.ts', ['eventOne', 'eventTwo']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFileOfSize('src/bundle.min.js', 'Avo.eventTwo();\n', 11 * MiB);

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(output()).toEqual([
        'warn Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   ├─ eventOne\n' +
          '   │  └─ used in src/a.ts: 1 time\n' +
          '   └─ eventTwo\n' +
          '      └─ ✖ no usage found\n',
        'info 1 of 2 events seen in code',
        'error 1 missing event',
        'missingEvents\n└─ Web (Avo.ts)\n   └─ eventTwo: no usage found\n',
      ]);
      expect(exitSpy.mock.calls).toEqual([[1]]);
    });

    // Tracked-but-ignored files only come from git, and the fallback warning
    // only from the walker, so each listing prints every warning it can.
    it.each([
      {
        listedBy: 'git',
        setUp: (): void => undefined,
        warnings: [
          'warn Skipped 1 tracked file that matches an ignore rule; run with --verbose to list it.',
          'warn Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
        ],
      },
      {
        listedBy: 'the walker',
        setUp: (): void => {
          fs.rmSync('.git', { recursive: true, force: true });
        },
        warnings: [
          'warn Listed 4 files without git because not a git repository (or any of the parent directories): .git.',
          'warn Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
        ],
      },
    ])(
      'leaves the exit code alone when every event is found, even with every warning $listedBy can print',
      async ({ setUp, warnings }) => {
        writeAvoFile('Avo.ts', ['eventOne']);
        writeFile('src/legacy/old.ts', 'Avo.eventOne();\n');
        commitAll('.');
        writeFile('.gitignore', 'legacy/\n');
        writeFile('src/a.ts', 'Avo.eventOne();\n');
        writeFileOfSize('src/bundle.min.js', 'Avo.eventOne();\n', 11 * MiB);
        setUp();

        await status(undefined, statusJson([webSource]), { verbose: false });

        expect(output().filter((line) => line.startsWith('warn'))).toEqual(
          warnings,
        );
        expect(output()).toContain('info 1 events seen in code');
        expect(exitSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe('listing order', () => {
    // Listing order puts `src/x.ts` before `src/x.ts-y.ts`, but sorting the
    // "used in" lines with localeCompare would put `-` before `:` and swap them.
    const listedFiles = ['src/x.ts', 'src/x.ts-y.ts', 'src/z.ts'];

    // Holds each listed file's read until all of them are in flight, then
    // finishes them last-listed first.
    const finishReadsInReverseOrder = (): void => {
      const realReadFile = fs.readFile;
      const held = new Map<string, () => void>();
      jest.spyOn(fs, 'readFile').mockImplementation(((
        filePath: string,
        encoding: string,
        callback: (error: unknown, data?: unknown) => void,
      ) => {
        realReadFile(filePath, encoding as any, (error, data) => {
          if (!listedFiles.includes(filePath)) {
            callback(error, data);
            return;
          }
          held.set(filePath, () => callback(error, data));
          if (held.size === listedFiles.length) {
            [...listedFiles]
              .reverse()
              .forEach((heldPath) => held.get(heldPath)());
          }
        });
      }) as any);
    };

    it('prints the "used in" lines and the --verbose file list in listing order', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      listedFiles.forEach((filePath) =>
        writeFile(filePath, 'Avo.eventOne();\n'),
      );
      finishReadsInReverseOrder();

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output()).toContain(
        'info Looking in files: src/x.ts\nsrc/x.ts-y.ts\nsrc/z.ts',
      );
      expect(output()).toContain(
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      ├─ used in src/x.ts: 1 time\n' +
          '      ├─ used in src/x.ts-y.ts: 1 time\n' +
          '      └─ used in src/z.ts: 1 time\n',
      );
    });
  });

  describe('reads', () => {
    // 16 reads at the 10 MiB cap is the memory budget the spec signs off on.
    it('never has more than 16 reads in flight', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      for (let index = 0; index < 40; index += 1) {
        writeFile(`src/file${index}.ts`, 'Avo.eventOne();\n');
      }
      const realReadFile = fs.readFile;
      let inFlight = 0;
      let maxInFlight = 0;
      jest.spyOn(fs, 'readFile').mockImplementation(((
        filePath: string,
        encoding: string,
        callback: (error: unknown, data?: unknown) => void,
      ) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          realReadFile(filePath, encoding as any, (error, data) => {
            inFlight -= 1;
            callback(error, data);
          });
        }, 1);
      }) as any);

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(maxInFlight).toBe(16);
      expect(output()[0].match(/used in src\/file/g)).toHaveLength(40);
    });

    it('skips symlinks', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      fs.symlinkSync('a.ts', 'src/link.ts');
      const readFileSpy = jest.spyOn(fs, 'readFile');

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(readPaths(readFileSpy)).not.toContain('src/link.ts');
      expect(output()).toContain(
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      └─ used in src/a.ts: 1 time\n',
      );
    });

    // git still lists a tracked file once its folder is replaced by a symlink,
    // but lstat only sees the file itself. 3.7.0's walker never followed
    // symlinks, so nothing outside the project folder is read.
    it('skips a file whose folder is a symlink to outside the project folder', async () => {
      writeAvoFile('Avo.ts', ['eventOne', 'eventTwo']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFile('lib/calls.ts', 'Avo.eventTwo();\n');
      commitAll('.');
      // A sibling whose path starts with the project folder's.
      const outside = path.join(tempRoot(), 'project-outside');
      writeFile(path.join(outside, 'calls.ts'), 'Avo.eventTwo();\n');
      fs.rmSync('lib', { recursive: true, force: true });
      fs.symlinkSync(outside, 'lib');
      const readFileSpy = jest.spyOn(fs, 'readFile');

      await status(undefined, statusJson([webSource]), { verbose: false });

      expect(readPaths(readFileSpy)).not.toContain('lib/calls.ts');
      expect(output()).toContain(
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   ├─ eventOne\n' +
          '   │  └─ used in src/a.ts: 1 time\n' +
          '   └─ eventTwo\n' +
          `      └─ ${logSymbols.error} no usage found\n`,
      );
      expect(exitSpy.mock.calls).toEqual([[1]]);
    });

    it('tolerates a listed file deleted from disk, or one it cannot read', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFile('src/deleted.ts', 'Avo.eventOne();\n');
      writeFile('src/unreadable.ts', 'Avo.eventOne();\n');
      fs.chmodSync('src/unreadable.ts', 0o000);
      // Deleted after listing, as a file missing from a sparse checkout or
      // removed mid-run would be.
      const realLstat = fs.lstat;
      jest.spyOn(fs, 'lstat').mockImplementation(((
        filePath: string,
        callback: (error: unknown, stats?: unknown) => void,
      ) => {
        if (filePath === 'src/deleted.ts') {
          fs.unlinkSync(filePath);
        }
        realLstat(filePath, callback);
      }) as any);

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(output()).toContain(
        'warn Failed to read file stats: src/deleted.ts',
      );
      expect(output()).toContain(
        'warn Failed to parse file: src/unreadable.ts',
      );
      expect(output()).toContain(
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      └─ used in src/a.ts: 1 time\n',
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    // git lists what is in its index, so a tracked file can be listed without
    // being on disk.
    it('tolerates a tracked file deleted from disk, or left out by a sparse checkout', async () => {
      writeAvoFile('Avo.ts', ['eventOne']);
      writeFile('src/a.ts', 'Avo.eventOne();\n');
      writeFile('src/deleted.ts', 'Avo.eventOne();\n');
      writeFile('lib/sparse.ts', 'Avo.eventOne();\n');
      commitAll('.');
      git('.', 'sparse-checkout', 'set', 'src');
      fs.unlinkSync('src/deleted.ts');

      await status(undefined, statusJson([webSource]), { verbose: true });

      expect(fs.existsSync('lib/sparse.ts')).toBe(false);
      expect(output()).toContain(
        'warn Failed to read file stats: lib/sparse.ts',
      );
      expect(output()).toContain(
        'warn Failed to read file stats: src/deleted.ts',
      );
      expect(output()).toContain(
        'sources\n' +
          '└─ Web (Avo.ts)\n' +
          '   └─ eventOne\n' +
          '      └─ used in src/a.ts: 1 time\n',
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
