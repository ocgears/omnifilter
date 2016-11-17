const gulp = require('gulp');
const webpack = require('webpack-stream');
require('babel-loader');
require('html-loader');
const sass = require('gulp-sass');
const maps = require('gulp-sourcemaps');
const minifyCss = require('gulp-minify-css');

gulp.task('html:dev', () => {
  gulp.src(__dirname + '/app/**/*.html')
    .pipe(gulp.dest(__dirname + '/build'));
});

gulp.task('css:dev', () => {
  gulp.src(__dirname + '/app/**/*.css')
    .pipe(gulp.dest(__dirname + '/build'));
});

gulp.task('sass:dev', () => {
  gulp.src(__dirname + '/app/**/*.scss')
    .pipe(maps.init())
    .pipe(sass().on('error', sass.logError))
    .pipe(minifyCss())
    .pipe(maps.write('./'))
    .pipe(gulp.dest(__dirname + '/build'));
});

gulp.task('images:dev', () => {
  gulp.src(__dirname + '/app/images/**/*')
    .pipe(gulp.dest(__dirname + '/build/images'));
});

gulp.task('favicon:dev', () => {
  gulp.src(__dirname + '/favicon.ico')
    .pipe(gulp.dest(__dirname + '/build/'));
});

gulp.task('webpack:dev', () => {
  gulp.src('./app/js/client.js')
    .pipe(webpack({
      output: {
        filename: 'bundle.js'
      }
    }))
    .pipe(gulp.dest(__dirname + '/build'));
});

gulp.task('webpack:test', () => {
  gulp.src(__dirname + '/app/test/test_entry.js')
    .pipe(webpack({
      module: {
        loaders: [
          {
            test: /\.html$/,
            loader: 'html'
          }
        ]
      },
      output: {
        filename: 'test_bundle.js'
      }
    }))
    .pipe(gulp.dest(__dirname + '/app/test/bndl/'));
});

gulp.task('build:dev', ['webpack:dev', 'html:dev', 'css:dev',
  'sass:dev', 'images:dev', 'favicon:dev']);
gulp.task('default', ['build:dev', 'webpack:test']);
