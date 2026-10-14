var angular = require('angular');

describe('photos controller filters', () => {
  var $httpBackend;
  var $scope;
  var preview;
  var filters = [
    { name: 'blur', label: 'Gaussian blur', group: 'Blur & sharpen', description: 'Smooth blur.',
      params: [{ name: 'radius', type: 'range', min: 0.1, max: 5, step: 0.01, default: 0.67 }] },
    { name: 'sobel', label: 'Sobel edges', group: 'Edges & relief', description: 'Edges.',
      params: [{ name: 'style', type: 'select', options: [{ value: 'neon', label: 'Neon' }, { value: 'ink', label: 'Ink' }], default: 'neon' }] }
  ];
  var presets = {
    maxLayers: 3,
    layerParams: [
      { name: 'amount', type: 'range', min: 0, max: 100, step: 1, default: 100 },
      { name: 'blend', type: 'select', options: [{ value: 'normal', label: 'Normal' }, { value: 'multiply', label: 'Multiply' }], default: 'normal' }
    ],
    presets: [{ name: 'inked', label: 'Inked', description: 'Blur with ink lines.', stack: [
      { tOption: 'blur', params: { radius: 2 } },
      { tOption: 'sobel', params: { style: 'ink' }, blend: 'multiply', amount: 60 }
    ] }]
  };

  beforeEach(angular.mock.module('omnifilterApp'));

  beforeEach(angular.mock.inject(function($rootScope, $controller, _$httpBackend_) {
    $httpBackend = _$httpBackend_;
    $scope = $rootScope.$new();
    $controller('PhotosController', { $scope: $scope });
    preview = document.createElement('img');
    preview.id = 'preview';
    document.body.appendChild(preview);
  }));

  afterEach(() => {
    document.body.removeChild(preview);
    $httpBackend.verifyNoOutstandingExpectation();
    $httpBackend.verifyNoOutstandingRequest();
  });

  function pick(layer, name) {
    layer.tOption = name;
    $scope.layerFilterChanged(layer);
  }

  it('loads the filter list and presets', () => {
    // Filters the server's device can't run are hidden.
    var unavailable = { name: 'swirl', label: 'Swirl', group: 'Distort', description: 'Twist.', params: [],
      available: false, unavailableReason: 'needs image (texture) support' };
    $httpBackend.expectGET('http://localhost:3000/filters').respond(200, filters.concat([unavailable]));
    $httpBackend.expectGET('http://localhost:3000/device').respond(200, { name: 'Iris', type: 'gpu', platform: 'Apple' });
    $httpBackend.expectGET('http://localhost:3000/presets').respond(200, presets);
    $scope.getFilters();
    $httpBackend.flush();
    expect($scope.device.name).toBe('Iris');
    expect($scope.filters.length).toBe(2);
    expect($scope.filterLabel('swirl')).toBe('swirl');
    expect($scope.presets.length).toBe(1);
    expect($scope.maxLayers).toBe(3);
    expect($scope.blendModes.length).toBe(2);
    expect($scope.filterLabel('sobel')).toBe('Sobel edges');
    expect($scope.filterLabel('')).toBe('Original');
  });

  it('starts each filter from its default settings', () => {
    $scope.filters = filters;
    var layer = $scope.layers[0];
    pick(layer, 'blur');
    expect(layer.params).toEqual({ radius: 0.67 });
    pick(layer, 'sobel');
    expect(layer.params).toEqual({ style: 'neon' });
  });

  it('sends a single filter with its settings', () => {
    $scope.filters = filters;
    pick($scope.layers[0], 'blur');
    $scope.layers[0].params.radius = 2;
    preview.setAttribute('src', 'data:image/png;base64,AAAA');
    $httpBackend.expectPOST('http://localhost:3000/newcontent', {
      content: 'data:image/png;base64,AAAA', tOption: 'blur', params: { radius: 2 }
    }).respond(200, { _id: '1', tOption: 'blur', content: 'x' });
    $scope.transformPhoto();
    expect($scope.transforming).toBe(true);
    $httpBackend.flush();
    expect($scope.transforming).toBe(false);
    expect($scope.photos.length).toBe(1);
  });

  it('sends stacked filters as a stack, skipping empty layers', () => {
    $scope.filters = filters;
    $scope.maxLayers = 3;
    pick($scope.layers[0], 'blur');
    $scope.addLayer();
    $scope.addLayer();
    pick($scope.layers[2], 'sobel');
    $scope.layers[2].blend = 'multiply';
    $scope.layers[2].amount = 50;
    preview.setAttribute('src', 'data:image/png;base64,AAAA');
    $httpBackend.expectPOST('http://localhost:3000/newcontent', {
      content: 'data:image/png;base64,AAAA',
      stack: [
        { tOption: 'blur', params: { radius: 0.67 }, amount: 100, blend: 'normal' },
        { tOption: 'sobel', params: { style: 'neon' }, amount: 50, blend: 'multiply' }
      ]
    }).respond(200, { _id: '2', tOption: '', tStack: [{ tOption: 'blur' }, { tOption: 'sobel' }], content: 'x' });
    $scope.transformPhoto();
    $httpBackend.flush();
    expect($scope.photoLabel($scope.photos[0])).toBe('Gaussian blur + Sobel edges');
  });

  it('sends one filter at partial strength as a stack', () => {
    $scope.filters = filters;
    pick($scope.layers[0], 'blur');
    $scope.layers[0].amount = 40;
    preview.setAttribute('src', 'data:image/png;base64,AAAA');
    $httpBackend.expectPOST('http://localhost:3000/newcontent', {
      content: 'data:image/png;base64,AAAA',
      stack: [{ tOption: 'blur', params: { radius: 0.67 }, amount: 40, blend: 'normal' }]
    }).respond(200, { _id: '3', content: 'x' });
    $scope.transformPhoto();
    $httpBackend.flush();
  });

  it('fills in the layers from a preset', () => {
    $scope.filters = filters;
    $scope.presets = presets.presets;
    $scope.selection.preset = 'inked';
    $scope.applyPreset();
    expect($scope.layers).toEqual([
      { tOption: 'blur', params: { radius: 2 }, amount: 100, blend: 'normal' },
      { tOption: 'sobel', params: { style: 'ink' }, amount: 60, blend: 'multiply' }
    ]);
    // Changing a layer's filter means it's no longer the preset.
    pick($scope.layers[1], 'blur');
    expect($scope.selection.preset).toBe(null);
  });

  it('keeps a preset\'s settings when the filter list has not loaded yet', () => {
    $scope.presets = presets.presets;
    $scope.selection.preset = 'inked';
    $scope.applyPreset();
    expect($scope.layers[0].params).toEqual({ radius: 2 });
    expect($scope.layers[1].params).toEqual({ style: 'ink' });
    // Once it arrives, missing settings get their defaults and given ones stay.
    delete $scope.layers[0].params.radius;
    $httpBackend.expectGET('http://localhost:3000/filters').respond(200, filters);
    $httpBackend.expectGET('http://localhost:3000/device').respond(200, {});
    $httpBackend.expectGET('http://localhost:3000/presets').respond(200, presets);
    $scope.getFilters();
    $httpBackend.flush();
    expect($scope.layers[0].params).toEqual({ radius: 0.67 });
    expect($scope.layers[1].params).toEqual({ style: 'ink' });
    expect($scope.selection.preset).toBe('inked');
  });

  it('marks and refuses presets that use filters the server cannot run', () => {
    $scope.filters = [filters[0]];
    $scope.filtersLoaded = true;
    $scope.presets = presets.presets;
    expect($scope.missingFilters(presets.presets[0])).toEqual(['sobel']);
    expect($scope.presetLabel(presets.presets[0])).toBe('Inked (not available here)');
    var before = $scope.layers;
    $scope.selection.preset = 'inked';
    $scope.applyPreset();
    expect($scope.layers).toBe(before);
    expect($scope.selection.preset).toBe(null);
    expect($scope.errors.length).toBe(1);
  });

  it('forgets the preset when the stack is edited', () => {
    $scope.filters = filters;
    $scope.presets = presets.presets;
    $scope.maxLayers = 3;
    ['removeLayer', 'moveLayer', 'addLayer', 'stackEdited'].forEach((edit) => {
      $scope.selection.preset = 'inked';
      $scope.applyPreset();
      if (edit === 'removeLayer') $scope.removeLayer(0);
      else if (edit === 'moveLayer') $scope.moveLayer(0, 1);
      else $scope[edit]();
      expect($scope.selection.preset).toBe(null);
    });
  });

  it('shows an error when the picked file could not be read', () => {
    var realFileReader = window.FileReader;
    var reader;
    window.FileReader = function() {
      reader = this;
      this.readAsDataURL = function() {};
    };
    var input = document.createElement('input');
    input.type = 'file';
    input.id = 'file';
    document.body.appendChild(input);
    try {
      $scope.createPhoto();
      var seen = [];
      $scope.$watch('errors.length', (n) => seen.push(n));
      // FileReader calls back later, outside any digest.
      reader.onloadend({ target: { result: null } });
      expect($scope.errors.length).toBe(1);
      expect(seen).toEqual([1]);
    } finally {
      window.FileReader = realFileReader;
      document.body.removeChild(input);
    }
  });

  it('reorders, removes and limits layers', () => {
    $scope.filters = filters;
    $scope.maxLayers = 2;
    pick($scope.layers[0], 'blur');
    $scope.addLayer();
    $scope.addLayer();
    expect($scope.layers.length).toBe(2);
    pick($scope.layers[1], 'sobel');
    $scope.moveLayer(1, -1);
    expect($scope.layers.map((l) => l.tOption)).toEqual(['sobel', 'blur']);
    $scope.moveLayer(0, -1);
    expect($scope.layers.map((l) => l.tOption)).toEqual(['sobel', 'blur']);
    $scope.removeLayer(0);
    $scope.removeLayer(0);
    // There's always one layer to pick a filter in.
    expect($scope.layers.length).toBe(1);
    expect($scope.layers[0].tOption).toBe(null);
  });

  it('refuses to transform without a picked image', () => {
    preview.setAttribute('src', '');
    $scope.transformPhoto();
    expect($scope.errors.length).toBe(1);
  });
});
