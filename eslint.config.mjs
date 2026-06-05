import nextVitals from 'eslint-config-next/core-web-vitals';

const config = [
  {
    ignores: ['lumimuse_flutter/**', '.tmp-tests/**'],
  },
  ...nextVitals,
  {
    files: ['src/app/layout.tsx'],
    rules: {
      '@next/next/no-page-custom-font': 'off',
    },
  },
  {
    files: [
      'src/app/characters/*/page.tsx',
      'src/components/chat/ChatInput.tsx',
      'src/components/chat/ChatView.tsx',
      'src/components/chat/ImageGenPanel.tsx',
      'src/components/chat/MessageBubble.tsx',
      'src/components/sidebar/CharacterList.tsx',
    ],
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
];

export default config;
