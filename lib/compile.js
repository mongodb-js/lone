var fs = require('fs-extra');
var request = require('request');
var tar = require('tar');
var os = require('os');
var path = require('path');
var async = require('async');
var isWindows = os.platform() === 'win32';
var config = require('./config');
var zlib = require('zlib');
var DiffMatchPatch = require('diff-match-patch');
var createRunner = require('./runner');
var dmp = new DiffMatchPatch();

function exemeta(fn) {
  var debug = require('debug')('lone:compile:exemeta');

  if (!isWindows) {
    debug('not windows so exemeta is moot');
    return fn(null, config);
  }

  var rc = path.resolve(config.node.working, './src/res/node.rc');

  fs.readFile(rc, 'utf-8', function(err, data) {
    if (err) {
      return fn(err);
    }
    var custom = data.replace(/VALUE "CompanyName", ".*"/, 'VALUE "CompanyName", "' + config.app.author + '"')
      .replace(/VALUE "ProductName", ".*"/, 'VALUE "ProductName", "' + config.app.name + '"')
      .replace(/VALUE "FileDescription", ".*"/, 'VALUE "FileDescription", "' + config.app.description + '"')
      .replace(/VALUE "FileVersion", .*/, 'VALUE "FileVersion", "' + config.app.version + '"')
      .replace(/VALUE "ProductVersion", .*/, 'VALUE "ProductVersion", "' + config.app.version + '"')
      .replace(/VALUE "OriginalFilename", ".*"/, 'VALUE "OriginalFilename", "' + config.app.name + '.exe"')
      .replace(/VALUE "InternalName", ".*"/, 'VALUE "InternalName", "' + config.app.name + '"');

    if (config.icon) {
      custom = custom.replace(/1 ICON .*/, '1 ICON ' + config.icon);
    }

    var patch = dmp.patch_make(data, custom);
    if (patch.length === 0) {
      debug('dont need to patch for icon');
      return fn(null, config);
    }
    debug('icon patch', patch.toString());
    debug('writing patched rc');
    fs.writeFile(rc, dmp.patch_apply(patch, data)[0], function(_err) {
      if (_err) {
        return fn(_err);
      }
      debug('patch applied!');
      return fn(null, config);
    });
  });
}

function download(fn) {
  var debug = require('debug')('lone:compile:download');

  fs.exists(config.node.dest, function(exists) {
    if (exists) {
      debug('already have', config.node.version);
      return fn();
    }

    debug('fetching', config.node.url);
    var out = fs.createWriteStream(config.node.dest).on('error', fn)
      .on('finish', function() {
        debug('saved', config.node.dest);
        fn();
      });
    var req = request(config.node.url);

    req.pipe(out);
    req.on('error', fn);
  });
}

function extract(fn) {
  var debug = require('debug')('lone:compile:extract');
  var ungzip;
  var input;
  var extractor;

  fs.exists(config.node.working, function(exists) {
    if (exists) {
      debug('already extracted', config.node.working);
      return fn(null, config);
    }

    debug('reading...', config.node.dest);
    input = fs.createReadStream(config.node.dest);
    ungzip = zlib.createGunzip();
    extractor = tar.Extract({
      path: config.cache
    });

    extractor.on('end', function() {
      debug('created', config.node.working);
      fn(null, config);
    });

    debug('ungzip-ing...');
    input.pipe(ungzip);
    ungzip.on('error', function(err) {
      debug('error ungziping', err);
      throw err;
    }).on('finished', function() {
      debug('ungzipped');
    });

    debug('untar-ing....');
    ungzip.pipe(extractor);
  });
}

function argvPatch(fn) {
  var src = path.resolve(config.node.working + '/src/node.cc');
  fs.readFile(src, 'utf-8', function(err, contents) {
    if (err) {
      return fn(err);
    }


    var patches = {
      // v_0_10_0: 'static void ParseArgs(int argc, char **argv) {',
      v_0_11_0: [
        [
          '      printf("%s\\n", NODE_VERSION);\n      exit(0);',
          '      // printf("%s\\n", NODE_VERSION);\n      // exit(0);'
        ],
        [
          '      PrintHelp();\n      exit(0);',
          '      // PrintHelp();\n      // exit(0);'
        ]
      ]
    };

    patches.v_0_11_0.map(function(p) {
      var find = p[0];
      var replace = p[1];
      contents = contents.replace(find, replace);
    });
    fs.writeFile(src, contents, fn);
  });
}

function embed(fn) {
  var debug = require('debug')('lone:compile:embed');
  var gyp = config.node.working + '/node.gyp';

  function copier(src, dest) {
    return function(cb) {
      fs.copy(src, dest, cb);
    };
  }

  function writer(dest, contents) {
    return function(cb) {
      fs.writeFile(dest, contents, cb);
    };
  }

  argvPatch(function() {
    debug('checking node.gyp patches');
    fs.readFile(gyp, function(err, data) {
      if (err) {
        return fn(err);
      }

      var src = data.toString();
      var tasks = [];
      var embeds;

      if (src.indexOf('lib/_third_party_main') > -1) {
        debug('already patched node.gyp');
        return fn(null, config);
      }

      embeds = ['_third_party_main', 'admzip'].map(function(name) {
        tasks.push(copier(path.join(__dirname, '..', 'embed', name + '.js'),
          path.join(config.node.working, 'lib', name + '.js')));
        return "      'lib/" + name + ".js'";
      }).join(',\n');

      tasks.push(writer(gyp, src.replace("'lib/zlib.js',",
        "'lib/zlib.js',\n" + embeds + ',')));

      debug('embedding lone js files');
      async.parallel(tasks, fn);
    });
  });
}

function make(fn) {
  var debug = require('debug')('lone:compile:make');
  fs.exists(config.node.out, function(exists) {
    if (exists) {
      debug('already have', config.node.out);
      return fn();
    }

    debug('building node from source...', 'go get a coffee!');
    debug('node will be built to', config.node.out);

    var run = createRunner(debug, config.node.working);
    if (isWindows) {
      return run('cmd /c vcbuild.bat nosign nosnapshot release')(fn);
    }
    async.series([run('./configure'), run('make --quiet')], fn);
  });
}

// get node source, extract it and embed files for lone.
module.exports = function(fn) {
  async.series([
    download,
    extract,
    embed,
    exemeta,
    make
  ], fn);
};
