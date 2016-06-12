let JsonFile = require('@exponent/json-file');

let existsAsync = require('exists-async');
let fs = require('fs');
let fsExtra = require('fs-extra');
let mkdirp = require('mkdirp');
let path = require('path');

let Api = require('./Api');
let User = require('./User');
let UrlUtils = require('./UrlUtils');
let UserSettings = require('./UserSettings');
let XDLError = require('./XDLError');
let ProjectSettings = require('./ProjectSettings');

let TEMPLATE_ROOT = path.resolve(__dirname, '../template');

function packageJsonForRoot(root) {
  return new JsonFile(path.join(root, 'package.json'));
}

async function determineEntryPointAsync(root) {
  let pkgJson = packageJsonForRoot(root);
  let pkg = await pkgJson.readAsync();
  let {
    main,
    exp,
  } = pkg;
  let entryPoint = main || 'index.js';
  if (exp && exp.entryPoint) {
    entryPoint = exp.entryPoint;
  }
  return entryPoint;
}

async function createNewExpAsync(root, info, opts = {}) {
  let pp = path.parse(root);
  let name = pp.name;

  let author = await UserSettings.getAsync('email', null);

  let templatePackageJsonFile = new JsonFile(path.join(__dirname, '../template/package.json'));
  let templatePackageJson = await templatePackageJsonFile.readAsync();

  info = Object.assign(info, templatePackageJson);

  let data = Object.assign({
    name,
    version: '0.0.0',
    description: "Hello Exponent!",
    author,
    //license: "MIT",
    // scripts: {
    //   "test": "echo \"Error: no test specified\" && exit 1"
    // },
  }, info);

  let pkgJson = new JsonFile(path.join(root, 'package.json'));

  let exists = await existsAsync(pkgJson.file);
  if (exists && !opts.force) {
    throw new XDLError('WONT_OVERWRITE_WITHOUT_FORCE', "Refusing to create new Exp because package.json already exists at root");
  }

  await mkdirp.promise(root);

  let result = await pkgJson.writeAsync(data);

  // Copy the template directory, which contains node_modules, without its
  // package.json
  await fsExtra.promise.copy(TEMPLATE_ROOT, root, {
    filter: filePath => filePath !== path.join(TEMPLATE_ROOT, 'package.json')
  });

  // Custom code for replacing __NAME__ in main.js
  let mainJs = await fs.readFile.promise(path.join(TEMPLATE_ROOT, 'main.js'), 'utf8');
  let customMainJs = mainJs.replace(/__NAME__/g, data.name);
  result = await fs.writeFile.promise(path.join(root, 'main.js'), customMainJs, 'utf8');

  return data;
}

async function saveRecentExpRootAsync(root) {
  root = path.resolve(root);

  // Write the recent Exps JSON file
  let recentExpsJsonFile = UserSettings.recentExpsJsonFile();
  let recentExps = await recentExpsJsonFile.readAsync({cantReadFileDefault: []});
  // Filter out copies of this so we don't get dupes in this list
  recentExps = recentExps.filter(function(x) {
    return x !== root;
  });
  recentExps.unshift(root);
  return await recentExpsJsonFile.writeAsync(recentExps.slice(0, 100));
}

function getHomeDir() {
  return process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];
}

function makePathReadable(pth) {
  let homedir = getHomeDir();
  if (pth.substr(0, homedir.length) === homedir) {
    return '~' + pth.substr(homedir.length);
  } else {
    return pth;
  }
}

async function expInfoAsync(root) {
  let pkgJson = packageJsonForRoot(root);
  let pkg = await pkgJson.readAsync();
  let name = pkg.name;
  let description = pkg.description;
  return {
    readableRoot: makePathReadable(root),
    root,
    name,
    description,
  };
}

async function expInfoSafeAsync(root) {
  try {
    return await expInfoAsync(root);
  } catch (e) {
    return null;
  }
}

// TODO: remove
async function getPublishInfoAsync(root) {
  let username = await User.getUsernameAsync();
  let pkgJson = packageJsonForRoot(root);
  let pkg = await pkgJson.readAsync();
  let {
    name,
    version,
    exp,
  } = pkg;

  if (!exp || !exp.sdkVersion) {
    throw new Error(`exp.sdkVersion is missing from package.json file`);
  }

  let remotePackageName = name;
  let remoteUsername = username;
  let remoteFullPackageName = '@' + remoteUsername + '/' + remotePackageName;
  let localPackageName = name;
  let packageVersion = version;
  let sdkVersion = exp.sdkVersion;

  let entryPoint = await determineEntryPointAsync(root);
  let ngrokUrl = await UrlUtils.constructPublishUrlAsync(root, entryPoint);
  return {
    args: {
      username,
      localPackageName,
      packageVersion,
      remoteUsername,
      remotePackageName,
      remoteFullPackageName,
      ngrokUrl,
      sdkVersion,
    },
    body: pkg,
  };
}

async function recentValidExpsAsync() {
  let recentExpsJsonFile = UserSettings.recentExpsJsonFile();
  let recentExps = await recentExpsJsonFile.readAsync({cantReadFileDefault: []});

  let results = await Promise.all(recentExps.map(expInfoSafeAsync));
  let filteredResults = results.filter(result => result);
  return filteredResults.slice(0, 5);
}

async function publishAsync(root, opts) {
  let publishInfo = await getPublishInfoAsync(root);
  if (opts) {
    publishInfo.args = Object.assign(publishInfo.args, opts);
  }
  let result = await Api.callMethodAsync('publish', [publishInfo.args], 'post', publishInfo.body);
  return result;
}

async function sendAsync(recipient, url_) {
  let result = await Api.callMethodAsync('send', [recipient, url_]);
  return result;
}

// TODO: figure out where these functions should live
async function getProjectRandomnessAsync(projectRoot) {
  let ps = await ProjectSettings.readAsync(projectRoot);
  let randomness = ps.urlRandomness;
  if (!randomness) {
    randomness = UrlUtils.someRandomness();
    ProjectSettings.setAsync(projectRoot, {'urlRandomness': randomness});
  }
  return randomness;
}

async function getLoggedOutPlaceholderUsernameAsync() {
  let lpu = await UserSettings.getAsync('loggedOutPlaceholderUsername', null);
  if (!lpu) {
    lpu = UrlUtils.randomIdentifierForLoggedOutUser();
    await UserSettings.setAsync('loggedOutPlaceholderUsername', lpu);
  }
  return lpu;
}

module.exports = {
  createNewExpAsync,
  determineEntryPointAsync,
  getPublishInfoAsync,
  packageJsonForRoot,
  publishAsync,
  recentValidExpsAsync,
  saveRecentExpRootAsync,
  sendAsync,
  getProjectRandomnessAsync,
  getLoggedOutPlaceholderUsernameAsync,
};