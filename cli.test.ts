// Set test mode before importing cli to prevent yargs execution
process.env.AVO_TEST_MODE = 'true';

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import os from 'os';
import {
  getEventsDirectoryPath,
  isFilePerEventMode,
  eventNameToFileName,
  cleanupObsoleteEventFiles,
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
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.ts'))).toBe(false);
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
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.kt'))).toBe(false);
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
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.swift'))).toBe(false);
      // Verify remaining file still exists
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.swift'))).toBe(true);
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
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.ts'))).toBe(false);
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
      expect(fs.existsSync(path.join(eventsDir, 'eventDeleted.ts'))).toBe(false);
      expect(fs.existsSync(path.join(eventsDir, 'eventClicked.ts'))).toBe(true);
      expect(fs.existsSync(path.join(eventsDir, 'eventViewed.ts'))).toBe(true);
    });
  });
});

