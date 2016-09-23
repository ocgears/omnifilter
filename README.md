# omnifilter        ![alt tag](https://travis-ci.org/ocgears/omnifilter.svg?branch=master)
###### An image processing library designed on the theory of parallel processing to apply filters to photos extremely quickly and efficiently.

## Contents
+   [Overview](https://github.com/ocgears/omnifilter#overview)
+   [Usage](https://github.com/ocgears/omnifilter#usage)
+   [API](https://github.com/ocgears/omnifilter#api)
+   [Dependencies](https://github.com/ocgears/omnifilter#dependencies)
+   [Authors](https://github.com/ocgears/omnifilter#authors)
+   [License](https://github.com/ocgears/omnifilter#license)

# Overview
Application is still under development, thank you for your patience.

# Usage
Installing on NPM
```
npm install omnifilter
```

Or you can clone our repo directly from GITHUB

### API
Content model
```
{
user_id: { type: String, required: true },
title: String,
createdOn: String,
tags: [String],
location: String,
tOption: String,
content: { type: mongoose.Schema.Types.Mixed, required: true },
createdAt: { type: Date, default: Date.now }
}
```

User model
```
}
email: String,
password: String
}
```

### Dependencies


### Authors
Aaron Filson [Github](https://github.com/aaronfilson)<br/>
Stephen Salzer [Github](https://github.com/scoobahsteve)</br>
Rob Merrill [Github](https://github.com/robgmerrill)</br>
Erika Hokanson [Github](https://github.com/erikawho)<br>
Gene Troy [Github](https://github.com/energene)<br/>

## License

This project is licensed under the terms of the MIT license. (view file titled [LICENSE](https://github.com/ocgears/omnifilter/blob/master/LICENSE))
