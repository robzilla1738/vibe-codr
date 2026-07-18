module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { "import-async-storage": "async-storage" }],
    ],
  };
};
