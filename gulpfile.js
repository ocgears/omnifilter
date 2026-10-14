const gulp = require('gulp');
const webpack = require('webpack-stream');
const sass = require('gulp-sass')(require('sass'));
const maps = require('gulp-sourcemaps');
const cleanCss = require('gulp-clean-css');
const path = require('path');
const { Transform } = require('stream');

// gulp 5 reads files as utf8 text by default, which corrupts binary files.
const binary = { encoding: false };

// `gulp build:prod`, `gulp --production` or NODE_ENV=production builds a
// minified bundle without source maps. Otherwise it's a development build.
let production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

// OMNIFILTER_API=<url> (or '/' for the same origin as the page) at build time
// writes the API's address into index.html; see app/js/services/api_base.js.
function injectApiBase() {
  const api = process.env.OMNIFILTER_API;
  return new Transform({
    objectMode: true,
    transform(file, enc, done) {
      if (api !== undefined && path.basename(file.path) === 'index.html' && file.isBuffer()) {
        const attr = api.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        file.contents = Buffer.from(file.contents.toString().replace(/(<meta charset="UTF-8">)/i,
          '$1\n    <meta name="omnifilter-api" content="' + attr + '">'));
      }
      done(null, file);
    }
  });
}

gulp.task('html:dev', () => {
  return gulp.src(__dirname + '/app/**/*.html')
    .pipe(injectApiBase())
    .pipe(gulp.dest(__dirname + '/dist'));
});

gulp.task('css:dev', () => {
  return gulp.src(__dirname + '/app/**/*.css')
    .pipe(gulp.dest(__dirname + '/dist'));
});

gulp.task('sass:dev', () => {
  if (production) {
    return gulp.src(__dirname + '/app/**/*.scss')
      .pipe(sass().on('error', sass.logError))
      .pipe(cleanCss())
      .pipe(gulp.dest(__dirname + '/dist'));
  }
  return gulp.src(__dirname + '/app/**/*.scss')
    .pipe(maps.init())
    .pipe(sass().on('error', sass.logError))
    .pipe(cleanCss())
    .pipe(maps.write('./'))
    .pipe(gulp.dest(__dirname + '/dist'));
});

gulp.task('images:dev', () => {
  return gulp.src(__dirname + '/app/images/**/*', binary)
    .pipe(gulp.dest(__dirname + '/dist/images'));
});

gulp.task('favicon:dev', () => {
  return gulp.src(__dirname + '/favicon.ico', binary)
    .pipe(gulp.dest(__dirname + '/dist/'));
});

gulp.task('webpack:dev', () => {
  return gulp.src('./app/js/client.js')
    .pipe(webpack({
      mode: production ? 'production' : 'development',
      devtool: production ? false : 'source-map',
      output: {
        filename: 'bundle.js'
      }
    }))
    .pipe(gulp.dest(__dirname + '/dist'));
});

gulp.task('webpack:test', () => {
  return gulp.src(__dirname + '/app/test/test_entry.js')
    .pipe(webpack({
      mode: 'development',
      module: {
        rules: [
          {
            test: /\.html$/,
            loader: 'html-loader',
            // Plain strings for $templateCache; leave {{bindings}} in src alone.
            options: { esModule: false, sources: false }
          }
        ]
      },
      output: {
        filename: 'test_bundle.js'
      }
    }))
    .pipe(gulp.dest(__dirname + '/app/test/bndl/'));
});

gulp.task('build:dev', gulp.parallel('webpack:dev', 'html:dev', 'css:dev',
  'sass:dev', 'images:dev', 'favicon:dev'));
gulp.task('default', gulp.series('build:dev'));

// The same tasks in production mode. A dist/ left over from a development
// build may still hold its .map files; the Docker build always starts clean.
gulp.task('build:prod', gulp.series((done) => {
  production = true;
  done();
}, 'build:dev'));
