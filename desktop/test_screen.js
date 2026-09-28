// Test script to run inside Electron
const { app, screen, desktopCapturer } = require('electron');

app.whenReady().then(async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    console.log(`Screen resolution: ${width}x${height}`);
    
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    
    console.log(`Found ${sources.length} screen source(s)`);
    
    if (sources.length > 0) {
      const img = sources[0].thumbnail.toPNG();
      const fs = require('fs');
      const path = require('path');
      const outPath = path.join(__dirname, 'test_screenshot.png');
      fs.writeFileSync(outPath, img);
      console.log(`Screenshot saved to ${outPath} (${img.length} bytes)`);
    }
    
    app.quit();
  } catch (err) {
    console.error('Error:', err.message);
    app.quit();
  }
});
