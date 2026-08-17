// Set test mode before importing cli to prevent yargs execution
process.env.AVO_TEST_MODE = 'true';

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
} from './cli.js';

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
