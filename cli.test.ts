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
import {
  getEventsDirectoryPath,
  isFilePerEventMode,
  eventNameToFileName,
  cleanupObsoleteEventFiles,
  buildFolderMessage,
  buildInterfaceFolderMessage,
  buildFilenameMessage,
  buildInterfaceFilenameMessage,
  extractConflictingFiles,
  buildResolvedAvoJson,
  findUnresolvableAvoJsonConflict,
  LIBRARY_INTERFACE_FILE_FILTER_VALUES,
  parseLibraryInterfaceFileFilter,
  resolveLibraryInterfaceFileFilter,
  buildPullRequestBody,
  validateAvoJson,
  loadAvoJson,
  loadAvoJsonOrInit,
  applyBranchToAvoJson,
  codegen,
  applyPullResult,
  buildLibraryInterfaceFileFilterInfoLine,
  buildLibraryInterfaceFileFilterPrompt,
  resolveInitLibraryInterfaceFileFilter,
  init,
  collectStaleSuppressedFiles,
  buildStaleSuppressedFileWarning,
} from './cli.js';

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

  it('buildInterfaceFolderMessage includes the provided outputDirExample', () => {
    const result = buildInterfaceFolderMessage({
      outputDirExample: 'Sources/Analytics',
    });
    expect(result).toContain('Sources/Analytics');
  });

  it('buildInterfaceFolderMessage falls back to src/analytics when outputDirExample is omitted', () => {
    const result = buildInterfaceFolderMessage({});
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
    '  "teamNote": "shared interface repo",',
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

  describe('buildPullRequestBody', () => {
    it('resolves each source independently in one request', () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      json.sources[0].libraryInterfaceFileFilter = 'interface-only';

      const body = buildPullRequestBody(json, json.sources);

      expect(body.sources[0].libraryInterfaceFileFilter).toBe('interface-only');
      expect(body.sources[1].libraryInterfaceFileFilter).toBe('events-only');
    });

    it('sends exactly the four per-source fields', () => {
      const json: any = baseJson();

      const body = buildPullRequestBody(json, json.sources);

      expect(Object.keys(body.sources[0])).toEqual([
        'id',
        'path',
        'interfacePath',
        'libraryInterfaceFileFilter',
      ]);
      expect(body.sources[0]).toEqual({
        id: 'source-1',
        path: 'src/Avo.ts',
        interfacePath: 'src/Avo.ts',
        libraryInterfaceFileFilter: 'all',
      });
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

    it('runs codegen when the response is ok', () => {
      const json: any = baseJson();
      const runCodegen = jest.fn();
      const retry = jest.fn();
      const result: any = { ok: true, sources: [] };

      applyPullResult('Web', json, result, 'events-only', {
        runCodegen,
        retry,
      });

      expect(runCodegen).toHaveBeenCalledWith(json, result);
      expect(retry).not.toHaveBeenCalled();
    });

    it('writes nothing and forwards the override to the post-checkout retry when the branch is closed', () => {
      const json: any = baseJson();
      json.libraryInterfaceFileFilter = 'events-only';
      fs.writeFileSync('avo.json', JSON.stringify(json, null, 2));
      const before = fs.readFileSync('avo.json', 'utf8');
      const retry = jest.fn();

      applyPullResult(
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
  const otherWorkspace = { id: 'schema-2', name: 'Other Workspace' };

  let previousCi: string | undefined;
  let previousIsTTY: boolean | undefined;

  beforeEach(() => {
    previousCi = process.env.CI;
    previousIsTTY = process.stdin.isTTY;
    delete process.env.CI;
  });

  afterEach(() => {
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    process.stdin.isTTY = previousIsTTY;
  });

  const fetchWorkspaces =
    (...workspaces: object[]) =>
    () =>
      Promise.resolve({ workspaces } as any);

  describe('copy helpers', () => {
    it('the info line names the setting, its values and where to set it', () => {
      const line = buildLibraryInterfaceFileFilterInfoLine();

      expect(line).toContain('libraryInterfaceFileFilter');
      expect(line).toContain('interface-only');
      expect(line).toContain('events-only');
      expect(line).toContain('all');
      expect(line).toContain('avo.json');
    });

    it('the prompt offers all three values and explains when it applies', () => {
      const prompt: any = buildLibraryInterfaceFileFilterPrompt();

      expect(prompt.type).toBe('list');
      expect(prompt.name).toBe('libraryInterfaceFileFilter');
      expect(prompt.choices.map((choice: any) => choice.value)).toEqual([
        'interface-only',
        'events-only',
        'all',
      ]);
      expect(prompt.message).toMatch(/generate/i);
      expect(prompt.message).toMatch(/library interface/i);
    });
  });

  describe('resolveInitLibraryInterfaceFileFilter', () => {
    it('asks once when a TTY is present and CI is unset', async () => {
      const promptFn = jest.fn(async () => ({
        libraryInterfaceFileFilter: 'events-only',
      })) as any;
      const reportInfo = jest.fn();

      const result = await resolveInitLibraryInterfaceFileFilter({
        isTTY: true,
        isCi: false,
        promptFn,
        reportInfo,
      });

      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(result).toBe('events-only');
      expect(reportInfo).not.toHaveBeenCalled();
    });

    it('skips the prompt and prints exactly one info line without a TTY', async () => {
      const promptFn = jest.fn();
      const reportInfo = jest.fn();

      const result = await resolveInitLibraryInterfaceFileFilter({
        isTTY: false,
        isCi: false,
        promptFn: promptFn as any,
        reportInfo,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
      expect(reportInfo).toHaveBeenCalledTimes(1);
    });

    it('skips the prompt in CI even with a TTY', async () => {
      const promptFn = jest.fn();
      const reportInfo = jest.fn();

      const result = await resolveInitLibraryInterfaceFileFilter({
        isTTY: true,
        isCi: true,
        promptFn: promptFn as any,
        reportInfo,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
      expect(reportInfo).toHaveBeenCalledTimes(1);
    });

    it('uses the pre-answer instead of prompting, even with a TTY', async () => {
      const promptFn = jest.fn();
      const reportInfo = jest.fn();

      const result = await resolveInitLibraryInterfaceFileFilter({
        preAnswer: 'events-only',
        isTTY: true,
        isCi: false,
        promptFn: promptFn as any,
        reportInfo,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(result).toBe('events-only');
    });

    it('rejects an invalid pre-answer', () => {
      expect(() =>
        resolveInitLibraryInterfaceFileFilter({
          preAnswer: 'eventsonly' as any,
          isTTY: true,
          isCi: false,
        }),
      ).toThrow(/must be one of interface-only, events-only, all/);
    });
  });

  describe('init()', () => {
    it('prompts for the filter on the single-workspace branch, which skips the workspace picker', async () => {
      const promptFn = jest.fn(async () => ({
        libraryInterfaceFileFilter: 'interface-only',
      })) as any;

      const json: any = await init(undefined, {
        fetchWorkspaces: fetchWorkspaces(workspace),
        promptFn,
        isTTY: true,
        isCi: false,
      });

      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(json.libraryInterfaceFileFilter).toBe('interface-only');
      // No library-mode gate: at init time there are no sources at all.
      expect('sources' in json).toBe(false);
    });

    it('prompts on the multi-workspace branch too', async () => {
      const promptFn = jest.fn(async (questions: any) => {
        if (questions[0].name === 'schema') {
          return { schema: otherWorkspace };
        }
        return { libraryInterfaceFileFilter: 'events-only' };
      }) as any;

      const json: any = await init(undefined, {
        fetchWorkspaces: fetchWorkspaces(workspace, otherWorkspace),
        promptFn,
        isTTY: true,
        isCi: false,
      });

      expect(promptFn).toHaveBeenCalledTimes(2);
      expect(json.schema.id).toBe('schema-2');
      expect(json.libraryInterfaceFileFilter).toBe('events-only');
    });

    it("writes only the explicit key when the user chooses 'all'", async () => {
      const promptFn = jest.fn(async () => ({
        libraryInterfaceFileFilter: 'all',
      })) as any;

      const json: any = await init(undefined, {
        fetchWorkspaces: fetchWorkspaces(workspace),
        promptFn,
        isTTY: true,
        isCi: false,
      });

      expect(json).toEqual({
        avo: json.avo,
        schema: { id: 'schema-1', name: 'Test Workspace' },
        branch: { id: 'master', name: 'main' },
        libraryInterfaceFileFilter: 'all',
      });
    });

    it('never reads stdin without a TTY, and omits the key entirely', async () => {
      const promptFn = jest.fn();
      const reportInfo = jest.fn();
      process.stdin.isTTY = false;

      const json: any = await init(undefined, {
        fetchWorkspaces: fetchWorkspaces(workspace),
        promptFn: promptFn as any,
        reportInfo,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect('libraryInterfaceFileFilter' in json).toBe(false);
      expect(reportInfo).toHaveBeenCalledTimes(1);
    });

    it('never reads stdin when CI is set, using the existing invokedByCi model', async () => {
      const promptFn = jest.fn();
      const reportInfo = jest.fn();
      process.env.CI = 'true';
      process.stdin.isTTY = true;

      const json: any = await init(undefined, {
        fetchWorkspaces: fetchWorkspaces(workspace),
        promptFn: promptFn as any,
        reportInfo,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect('libraryInterfaceFileFilter' in json).toBe(false);
      expect(reportInfo).toHaveBeenCalledTimes(1);
    });

    it('pre-answers from --libraryInterfaceFileFilter without prompting', async () => {
      const promptFn = jest.fn();
      process.stdin.isTTY = true;

      const json: any = await init('events-only', {
        fetchWorkspaces: fetchWorkspaces(workspace),
        promptFn: promptFn as any,
      });

      expect(promptFn).not.toHaveBeenCalled();
      expect(json.libraryInterfaceFileFilter).toBe('events-only');
    });
  });

  describe('implicit init from the pull path', () => {
    useTempCwd();

    it('completes in CI without prompting when avo.json is missing', async () => {
      const promptFn = jest.fn();
      process.env.CI = 'true';
      process.stdin.isTTY = true;

      const json: any = await loadAvoJsonOrInit({
        argv: { token: 'test-token' },
        skipInit: false,
        skipPullMaster: false,
        initFn: () =>
          init(undefined, {
            fetchWorkspaces: fetchWorkspaces(workspace),
            promptFn: promptFn as any,
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
