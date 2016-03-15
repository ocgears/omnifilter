const lwipPixels = require('/getPixels');
const lwip = require('lwip');

lwip.open(__dirname + 'image goes here', (err, img) => {
  console.log(lwipPixels(img));
});
