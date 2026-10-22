# Glossary

Terms used across the Avo CLI's code, specs and docs.

- **Project folder**: the folder `avo` runs from (the cwd), which holds `avo.json`. `avo status` never looks above it.
- **Listed file**: a file `avo status` considers, relative to the project folder. With git, the listed files are what git would show: tracked files plus untracked files that aren't ignored, minus tracked files that match an ignore rule, including the files of initialised submodules. Without git, they are what the `ignore-walk` walker finds.
- **Effective glob**: the glob that picks a source's analysed files: `analysis.glob` from `avo.json`, or a default from the source file's extension, minus the source's own file and its `<Module>Events/` folder.
- **Analysed file**: a listed file that matches some source's effective glob, isn't a symlink, and isn't an oversized file. Only analysed files are read.
- **Size cap**: 10 MiB (10 × 1024 × 1024 bytes). It is fixed.
- **Oversized file**: a listed file matching an effective glob whose size is strictly greater than the size cap. It is never read, and `avo status` warns about it.
