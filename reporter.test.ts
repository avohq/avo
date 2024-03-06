import { expect, test, vi } from 'vitest'; // eslint-disable-line import/no-extraneous-dependencies
import { tree } from './reporter.js';

test('tree', () => {
  const consoleSpy = vi.spyOn(console, 'log');
  tree('testing', []);
  expect(consoleSpy).toHaveBeenCalledWith('testing\n');

  tree('testing', [{ name: 'firstNode' }]);
  expect(consoleSpy).toHaveBeenCalledWith(`testing
└─ firstNode
`);

  tree('testing', [{ name: 'firstNode', children: [{ name: 'secondNode' }] }]);
  expect(consoleSpy).toHaveBeenCalledWith(`testing
└─ firstNode
   └─ secondNode
`);

  tree('testing', [
    {
      name: 'firstNode',
      children: [{ name: 'secondNode' }, { name: 'thirdNode' }],
    },
  ]);
  expect(consoleSpy).toHaveBeenCalledWith(`testing
└─ firstNode
   ├─ secondNode
   └─ thirdNode
`);

  tree('testing', [
    {
      name: 'firstNode',
      children: [
        { name: 'secondNode', children: [{ name: 'secondNodeChild' }] },
        { name: 'thirdNode' },
      ],
    },
  ]);
  expect(consoleSpy).toHaveBeenCalledWith(`testing
└─ firstNode
   ├─ secondNode
   │  └─ secondNodeChild
   └─ thirdNode
`);
});
