// Test data shared by the unit tests.
import { Filter, PresetList } from '../app/models';

export const FILTERS: Filter[] = [
  {
    name: 'blur',
    label: 'Gaussian blur',
    group: 'Blur',
    params: [
      { name: 'radius', label: 'Radius', type: 'range', min: 1, max: 20, step: 1, default: 3 },
    ],
  },
  { name: 'invert', label: 'Invert', group: 'Colour', params: [] },
  {
    name: 'sepia',
    label: 'Sepia',
    group: 'Colour',
    params: [
      { name: 'amount', label: 'Amount', type: 'range', min: 0, max: 100, step: 1, default: 80 },
      {
        name: 'tone',
        label: 'Tone',
        type: 'select',
        options: [
          { value: 'warm', label: 'Warm' },
          { value: 'cool', label: 'Cool' },
        ],
        default: 'warm',
      },
    ],
  },
];

export const PRESETS: PresetList = {
  maxLayers: 3,
  layerParams: [
    {
      name: 'amount',
      label: 'Strength (%)',
      type: 'range',
      min: 0,
      max: 100,
      step: 1,
      default: 100,
    },
    {
      name: 'blend',
      label: 'Blend',
      type: 'select',
      options: [
        { value: 'normal', label: 'Normal' },
        { value: 'multiply', label: 'Multiply' },
      ],
      default: 'normal',
    },
  ],
  presets: [
    {
      name: 'soft',
      label: 'Soft sepia',
      description: 'Blurred, then toned.',
      stack: [
        { tOption: 'blur', params: { radius: 9 } },
        { tOption: 'sepia', amount: 50 },
      ],
    },
    { name: 'dream', label: 'Dream', stack: [{ tOption: 'not_here' }] },
  ],
};
