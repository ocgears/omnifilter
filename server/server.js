var PORT = process.env.PORT || process.env.$PORT || 3000;
var clientPort = process.env.CLIENTPORT || 5000;
var hostURL = process.env.HOSTURL || 'http://localhost:';
const express = require('express');
const app = module.exports = exports = express();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGOLAB_URI || 'mongodb://localhost/omnifilter_app_dev');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', hostURL + clientPort);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, token');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  next();
});

const contentRouter = require(__dirname + '/routes/content_routes');
const authRouter = require(__dirname + '/routes/auth_routes');
const userRouter = require(__dirname + '/routes/user_routes');

app.use('/', contentRouter);
app.use('/', authRouter);
app.use('/', userRouter);

app.listen(PORT, () => console.log('Omnifilter backend server up on port: ' + PORT));
