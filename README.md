# Avo CLI

Better event tracking, **faster**.

![https://www.avo.app](https://cdn.avo.app/assets/avo-cado.png)

The Avo CLI gives you access to [Avo Codegen](https://www.avo.app/docs/implementation/devs-101) right from your command line. It allows you to pull [your Avo tracking plan](http://avo.app/schemas/default) as type-safe functions for each of your events, making analytics implementation quick and seamless. Avo Codegen supports a variety of [platforms, programming languages and destinations](https://www.avo.app/docs/implementation/supported-programming-languages). 

## Installation

Avo runs on Node `>=14.16`. To install the latest version of Avo CLI, run this command:

```
npm install -g avo
```

## Usage

```
$ avo --help
avo command

Commands:
  avo login              Log into the Avo platform
  avo init               Initialize an Avo workspace in the current folder
  avo pull [source]      Pull analytics wrappers from Avo workspace
  avo checkout [branch]  Switch branches                               [aliases: branch]
  avo source <command>   Manage sources for the current project
  avo status [source]    Show the status of the Avo implementation
  avo merge main         Pull the Avo main branch into your current branch
  avo conflict           Resolve git conflicts in Avo files            [aliases: resolve, conflicts]
  avo edit               Open the Avo workspace in your browser
  avo logout             Log out from the Avo platform
  avo whoami             Shows the currently logged in username

Options:
  --version      Show version number                                   [boolean]
  -v, --verbose  make output more verbose                              [boolean] [default: false]
  -f, --force    Proceed with merge when incoming branch is open       [boolean] [default: false]
  --help         Show help                                             [boolean]
```

For more documentation, visit [https://www.avo.app/docs/implementation/cli](https://www.avo.app/docs/implementation/cli)


**Caught a Bug?** Thank you, you are precious to us :hug: Please create a issue on the GitHub repo or send an email to friends@avo.app. We'll do our best to resolve it quickly!

**To create a release:**
1. Verify that the changes in the _Unreleased_ section in CHANGELOG.md are accurate, create a new heading with the correct semantic version then move the content from the _Unreleased_ section there
2. Udate the semantic version in `package.json` to match the one you just created in the changelog
3. Commit with the message `Release <version>` and push the changes
4. Publish the package to npm (you'll need to be a maintainer of the avo project in npm): `npm publish`
