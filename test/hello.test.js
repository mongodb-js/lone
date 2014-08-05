var assert = require('assert'),
  child_process = require('child_process'),
  lone = require('../'),
  path = require('path');

describe('hello', function(){
  after(path.remove.bind(null, path._additions));
  it('should deliver a runnable executable', function(done){
    lone({src: __dirname + '/fixtures/hello', node: '0.10.29'}, function(err, res){
      assert.ifError(err);

      assert.equal(res.ignore.length, 2, 'Should ignore lone and devDependencies');

      assert.equal(res.src, __dirname + '/fixtures/hello');
      child_process.exec(res.out, function(err, stdout){
        assert.ifError(err);

        assert.equal(stdout.toString().replace('\n', ''), 'hello');
        done();
      });
    });
  });
});
