![https://www.avo.app](https://firebasestorage.googleapis.com/v0/b/avo-frontpage.appspot.com/o/logo%2Fassets%2Favo.png?alt=media&token=2acfd7bd-2faf-4787-a450-8f99c407a483)

## Install

To install the latest version of Avo CLI, run this command:

```
npm install -g avo
```

## Usage

```
$ avo --help
avo command

Commands:
  avo init               Initialize an Avo workspace in the current folder
  avo pull [source]      Pull analytics wrappers from Avo workspace
  avo checkout [branch]  Switch branches                               [aliases: branch]
  avo source <command>   Manage sources for the current project
  avo status [source]    Show the status of the Avo implementation
  avo merge master       Pull Avo master branch into your current branch
  avo conflict           Resolve git conflicts in Avo files            [aliases: resolve, conflicts]
  avo edit               Open the Avo workspace in your browser
  avo login              Log into the Avo platform
  avo logout             Log out from the Avo platform
  avo whoami             Shows the currently logged in username

Options:
  --version      Show version number                                   [boolean]
  -v, --verbose  make output more verbose                              [boolean] [default: false]
  -f, --force    Proceed with merge when incoming branch is open       [boolean] [default: false]
  --help         Show help                                             [boolean]
```

For more detailed documentation, visit [https://www.avo.app/docs/commands](https://www.avo.app/docs/commands)

## Caught a Bug?

Thank you, you are precious to us :hug: Please send an email to friends@avo.app or file an issue here on GitHub.

## How to Commit

```
yarn commit
```

## How to Create a Release

```
npm run release-it
```

