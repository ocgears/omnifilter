{
  "targets": [
    {
      "target_name": "matrix",
      "sources": [ "matrix.cpp" ],
      "include_dirs": ["<!(node -e \"require('nan')\")"],
      "conditions": [
            ["OS=='mac'",
                {
                    "defines": [
                        "__MACOSX_CORE__"
                    ],
                    "architecture": "i386",
                    "xcode_settings": {
                        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
                    },
                    "link_settings": {
                        "libraries": [
                            "-framework",
                            "OpenCL" # this is how you use a framework on OSX
                        ]
                    }
                }
            ],
            ['OS=="linux"', {
                'defines': [
                  'LINUX_DEFINE',
                ],
                'link_settings': {
                    'libraries': [
                        '/opt/intel/opencl/lib64/libOpenCL.so'
                    ]
                },
                'include_dirs': [
                  '/etc/OpenCL/vendors/',
                  '/opt/opencl-headers/include/CL',
                  '/opt/intel/opencl/',
                  '/opt/intel/opencl/lib64'
                ],
                },
            ],
      ],
    },
  ],
}
