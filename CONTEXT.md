# Avo CLI

The command-line tool that pulls a team's Avo tracking plan into their codebase as generated code, and reports where that code is used.

## Language

**Project folder**:
The folder holding `avo.json`, where avo commands are run.
_Avoid_: workspace (that is an Avo workspace), root (clashes with the git root)

### Implementation status

**Listed file**:
A path under the project folder, submodules included, that `avo status` considers at all, once ignore rules have been applied.
_Avoid_: scanned file, walked file

**Analysed file**:
A listed file that matches a source's effective glob, is within the size cap, and is read to find where events are called.
_Avoid_: scanned file, cached file

**Size cap**:
The largest file, in bytes, that `avo status` will read.

**Oversized file**:
A listed file that matches a source's effective glob but is larger than the size cap, so it is not read.
_Avoid_: skipped file (tracked-but-ignored files and symlinks are skipped too), large file

**Effective glob**:
The pattern that decides which listed files a source analyses: the source's `analysis.glob` when set, otherwise a default derived from the source's file extension.
_Avoid_: analysis glob (when the default is meant too)
