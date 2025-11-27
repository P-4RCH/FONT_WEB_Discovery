import React, { useState } from 'react';
import { Search, Download, ExternalLink, FileText, Type } from 'lucide-react';

export default function FontScanner() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [debugInfo, setDebugInfo] = useState([]);

  const extractFontsFromCSS = (cssText, sourceUrl) => {
    const fonts = [];
    const fontFamilyUsages = [];
    
    // Match @font-face declarations
    const fontFaceRegex = /@font-face\s*{([^}]+)}/g;
    let match;
    
    while ((match = fontFaceRegex.exec(cssText)) !== null) {
      const block = match[1];
      const font = {
        source: sourceUrl,
        type: 'font-face'
      };
      
      // Extract font-family
      const familyMatch = block.match(/font-family:\s*['"]?([^'";]+)['"]?/i);
      if (familyMatch) font.family = familyMatch[1].trim();
      
      // Extract src (font files)
      const srcMatch = block.match(/src:\s*([^;]+);/i);
      if (srcMatch) {
        const urls = srcMatch[1].match(/url\(['"]?([^'"()]+)['"]?\)/g);
        if (urls) {
          font.files = urls.map(u => {
            const urlMatch = u.match(/url\(['"]?([^'"()]+)['"]?\)/);
            return urlMatch ? urlMatch[1] : u;
          });
        }
      }
      
      // Extract font-weight
      const weightMatch = block.match(/font-weight:\s*([^;]+);/i);
      if (weightMatch) font.weight = weightMatch[1].trim();
      
      // Extract font-style
      const styleMatch = block.match(/font-style:\s*([^;]+);/i);
      if (styleMatch) font.style = styleMatch[1].trim();
      
      // Extract font-display
      const displayMatch = block.match(/font-display:\s*([^;]+);/i);
      if (displayMatch) font.display = displayMatch[1].trim();
      
      // Extract unicode-range
      const unicodeMatch = block.match(/unicode-range:\s*([^;]+);/i);
      if (unicodeMatch) font.unicodeRange = unicodeMatch[1].trim();
      
      fonts.push(font);
    }
    
    // Extract ALL font-family declarations with context
    // This regex captures the selector and the font-family value
    const cssRules = cssText.split('}');
    
    for (let rule of cssRules) {
      if (!rule.trim()) continue;
      
      const parts = rule.split('{');
      if (parts.length < 2) continue;
      
      const selector = parts[0].trim();
      const declarations = parts[1];
      
      // Find all font-family declarations in this rule
      const fontFamilyRegex = /font-family:\s*([^;]+);?/gi;
      let familyMatch;
      
      while ((familyMatch = fontFamilyRegex.exec(declarations)) !== null) {
        const fullValue = familyMatch[1].trim();
        
        // Parse the font stack
        const fontStack = fullValue.split(',').map(f => f.trim().replace(/['"]/g, ''));
        
        fontFamilyUsages.push({
          selector: selector,
          fullValue: fullValue,
          fontStack: fontStack,
          primaryFont: fontStack[0],
          fallbacks: fontStack.slice(1),
          source: sourceUrl
        });
      }
    }
    
    return { 
      fontFaces: fonts, 
      fontFamilyUsages: fontFamilyUsages
    };
  };

  const scanWebsite = async () => {
    if (!url) {
      setError('Please enter a URL');
      return;
    }

    setLoading(true);
    setError('');
    setResults(null);
    setDebugInfo([]);

    try {
      // Fetch the HTML page
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `Fetch this URL and extract all CSS file links and inline styles: ${url}. Return ONLY a JSON object with this structure: {"cssLinks": ["url1", "url2"], "hasInlineStyles": true/false}. No other text.`
          }],
          tools: [{
            type: "web_fetch_20250304",
            name: "web_fetch"
          }]
        })
      });

      const data = await response.json();
      
      // Process the response to extract CSS URLs
      let cssLinks = [];
      let htmlContent = '';
      
      if (data.content) {
        for (const block of data.content) {
          if (block.type === 'tool_use' && block.name === 'web_fetch') {
            // Will be in tool_result in next turn
          } else if (block.type === 'text') {
            htmlContent += block.text;
          }
        }
      }

      // Parse HTML content to find CSS links
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlContent, 'text/html');
      const linkTags = doc.querySelectorAll('link[rel="stylesheet"]');
      const styleTags = doc.querySelectorAll('style');
      
      cssLinks = Array.from(linkTags).map(link => {
        const href = link.getAttribute('href');
        if (href.startsWith('http')) return href;
        if (href.startsWith('//')) return 'https:' + href;
        if (href.startsWith('/')) {
          const baseUrl = new URL(url);
          return baseUrl.origin + href;
        }
        return new URL(href, url).href;
      });

      const allFonts = [];
      const allFontFamilyUsages = [];
      const cssFiles = [];
      const debug = [];

      debug.push(`Found ${linkTags.length} external CSS links`);
      debug.push(`Found ${styleTags.length} inline style tags`);

      // Process inline styles
      for (const styleTag of styleTags) {
        const cssText = styleTag.textContent;
        const { fontFaces, fontFamilyUsages } = extractFontsFromCSS(cssText, 'inline-style');
        allFonts.push(...fontFaces);
        allFontFamilyUsages.push(...fontFamilyUsages);
        if (fontFaces.length > 0 || fontFamilyUsages.length > 0) {
          cssFiles.push({ 
            url: 'Inline <style> tag', 
            fontFaceCount: fontFaces.length,
            fontFamilyCount: fontFamilyUsages.length,
            size: `${(cssText.length / 1024).toFixed(2)} KB`
          });
          debug.push(`Inline style: ${fontFaces.length} @font-face, ${fontFamilyUsages.length} font-family`);
        }
      }

      // Fetch and process external CSS files (limited to first 10 for performance)
      debug.push(`\nFetching external CSS files (max 10)...`);
      
      for (let i = 0; i < Math.min(cssLinks.length, 10); i++) {
        const cssUrl = cssLinks[i];
        try {
          debug.push(`\nFetching: ${cssUrl}`);
          const cssResponse = await fetch(cssUrl);
          const cssText = await cssResponse.text();
          
          debug.push(`✓ Success: ${(cssText.length / 1024).toFixed(2)} KB`);
          
          const { fontFaces, fontFamilyUsages } = extractFontsFromCSS(cssText, cssUrl);
          allFonts.push(...fontFaces);
          allFontFamilyUsages.push(...fontFamilyUsages);
          
          const fileName = cssUrl.split('/').pop() || cssUrl;
          cssFiles.push({ 
            url: cssUrl,
            fileName: fileName,
            fontFaceCount: fontFaces.length,
            fontFamilyCount: fontFamilyUsages.length,
            size: `${(cssText.length / 1024).toFixed(2)} KB`,
            status: 'success'
          });
          
          debug.push(`  → Found: ${fontFaces.length} @font-face, ${fontFamilyUsages.length} font-family`);
        } catch (err) {
          debug.push(`✗ Failed: ${err.message}`);
          cssFiles.push({
            url: cssUrl,
            fileName: cssUrl.split('/').pop() || cssUrl,
            fontFaceCount: 0,
            fontFamilyCount: 0,
            size: 'N/A',
            status: 'failed',
            error: err.message
          });
        }
      }

      // Count unique fonts
      const uniquePrimaryFonts = new Set(allFontFamilyUsages.map(u => u.primaryFont));

      debug.push(`\n=== Summary ===`);
      debug.push(`Total @font-face: ${allFonts.length}`);
      debug.push(`Total font-family: ${allFontFamilyUsages.length}`);
      debug.push(`Unique primary fonts: ${uniquePrimaryFonts.size}`);

      setDebugInfo(debug);
      setResults({
        fonts: allFonts,
        fontFamilyUsages: allFontFamilyUsages,
        uniquePrimaryFonts: Array.from(uniquePrimaryFonts),
        cssFiles: cssFiles,
        totalCssFiles: cssLinks.length
      });

    } catch (err) {
      setError(`Error scanning website: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const exportResults = () => {
    const dataStr = JSON.stringify(results, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'font-metadata.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Type className="w-10 h-10 text-purple-400" />
            <h1 className="text-4xl font-bold text-white">Font Metadata Scanner</h1>
          </div>
          <p className="text-purple-200">Analyze and extract detailed font information from any website</p>
        </div>

        <div className="bg-white/10 backdrop-blur-md rounded-xl p-6 shadow-2xl mb-6">
          <div className="flex gap-3">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Enter website URL (e.g., https://example.com)"
              className="flex-1 px-4 py-3 bg-white/20 border border-purple-300/30 rounded-lg text-white placeholder-purple-200/60 focus:outline-none focus:ring-2 focus:ring-purple-400"
              onKeyPress={(e) => e.key === 'Enter' && scanWebsite()}
            />
            <button
              onClick={scanWebsite}
              disabled={loading}
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 text-white rounded-lg font-semibold flex items-center gap-2 transition-colors"
            >
              {loading ? (
                <>
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <Search className="w-5 h-5" />
                  Scan
                </>
              )}
            </button>
          </div>
          {error && (
            <div className="mt-4 p-4 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200">
              {error}
            </div>
          )}
        </div>

        {results && (
          <div className="space-y-6">
            {debugInfo.length > 0 && (
              <div className="bg-black/40 backdrop-blur-md rounded-xl p-6 border border-green-500/30">
                <h3 className="text-xl font-bold text-green-400 mb-4 flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  Debug Log - CSS File Processing
                </h3>
                <div className="bg-black/60 rounded-lg p-4 font-mono text-sm text-green-300 max-h-96 overflow-y-auto">
                  {debugInfo.map((line, idx) => (
                    <div key={idx} className="mb-1">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold text-white">Scan Results</h2>
              <button
                onClick={exportResults}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-2 transition-colors"
              >
                <Download className="w-4 h-4" />
                Export JSON
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white/10 backdrop-blur-md rounded-lg p-6">
                <div className="text-3xl font-bold text-purple-400">{results.fonts.length}</div>
                <div className="text-purple-200">@font-face Declarations</div>
              </div>
              <div className="bg-white/10 backdrop-blur-md rounded-lg p-6">
                <div className="text-3xl font-bold text-purple-400">{results.fontFamilyUsages.length}</div>
                <div className="text-purple-200">font-family Declarations</div>
              </div>
              <div className="bg-white/10 backdrop-blur-md rounded-lg p-6">
                <div className="text-3xl font-bold text-purple-400">{results.uniquePrimaryFonts.length}</div>
                <div className="text-purple-200">Unique Primary Fonts</div>
              </div>
            </div>

            {results.fontFamilyUsages.length > 0 && (
              <div className="bg-white/10 backdrop-blur-md rounded-xl p-6">
                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <Type className="w-5 h-5" />
                  Font-Family Declarations ({results.fontFamilyUsages.length} found)
                </h3>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {results.fontFamilyUsages.map((usage, idx) => (
                    <div key={idx} className="bg-white/5 rounded-lg p-4 border border-purple-300/20">
                      <div className="mb-2">
                        <span className="text-purple-200 text-xs">CSS Selector:</span>
                        <div className="text-purple-100 text-sm font-mono bg-black/20 px-2 py-1 rounded mt-1">
                          {usage.selector}
                        </div>
                      </div>
                      <div className="mb-2">
                        <span className="text-purple-200 text-xs">Full Declaration:</span>
                        <div className="text-white text-sm font-mono bg-black/20 px-2 py-1 rounded mt-1">
                          font-family: {usage.fullValue};
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        <div>
                          <span className="text-purple-200 text-xs">Primary Font:</span>
                          <span className="text-green-300 text-sm ml-2 font-semibold">{usage.primaryFont}</span>
                        </div>
                        {usage.fallbacks.length > 0 && (
                          <div>
                            <span className="text-purple-200 text-xs">Fallback Stack:</span>
                            <div className="text-purple-100 text-sm mt-1">
                              {usage.fallbacks.join(' → ')}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-purple-300 mt-2">
                        Source: {usage.source === 'inline-style' ? 'Inline Style' : new URL(usage.source).pathname.split('/').pop()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {results.fonts.length > 0 && (
              <div className="bg-white/10 backdrop-blur-md rounded-xl p-6">
                <h3 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  @font-face Declarations ({results.fonts.length} found)
                </h3>
                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {results.fonts.map((font, idx) => (
                    <div key={idx} className="bg-white/5 rounded-lg p-4 border border-purple-300/20">
                      <div className="font-semibold text-purple-300 text-lg mb-2">
                        {font.family || 'Unnamed Font'}
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        {font.weight && (
                          <div><span className="text-purple-200">Weight:</span> <span className="text-white">{font.weight}</span></div>
                        )}
                        {font.style && (
                          <div><span className="text-purple-200">Style:</span> <span className="text-white">{font.style}</span></div>
                        )}
                        {font.display && (
                          <div><span className="text-purple-200">Display:</span> <span className="text-white">{font.display}</span></div>
                        )}
                        {font.unicodeRange && (
                          <div className="col-span-2"><span className="text-purple-200">Unicode Range:</span> <span className="text-white text-xs">{font.unicodeRange}</span></div>
                        )}
                      </div>
                      {font.files && (
                        <div className="mt-3">
                          <div className="text-purple-200 text-xs mb-1">Font Files:</div>
                          {font.files.map((file, i) => (
                            <div key={i} className="text-xs text-purple-100 truncate bg-white/5 px-2 py-1 rounded mt-1">
                              {file}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="text-xs text-purple-300 mt-2">
                        Source: {font.source === 'inline-style' ? 'Inline Style' : font.source.split('/').pop()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {results.uniquePrimaryFonts && results.uniquePrimaryFonts.length > 0 && (
              <div className="bg-white/10 backdrop-blur-md rounded-xl p-6">
                <h3 className="text-xl font-bold text-white mb-4">Unique Primary Fonts</h3>
                <div className="flex flex-wrap gap-2">
                  {results.uniquePrimaryFonts.map((family, idx) => (
                    <span key={idx} className="px-3 py-1 bg-purple-600/30 text-purple-100 rounded-full text-sm border border-purple-400/30">
                      {family}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {results.cssFiles.length > 0 && (
              <div className="bg-white/10 backdrop-blur-md rounded-xl p-6">
                <h3 className="text-xl font-bold text-white mb-4">CSS Files Analyzed ({results.cssFiles.length})</h3>
                <div className="space-y-2">
                  {results.cssFiles.map((file, idx) => (
                    <div key={idx} className={`rounded-lg p-4 border ${file.status === 'failed' ? 'bg-red-500/10 border-red-500/30' : 'bg-white/5 border-purple-300/20'}`}>
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1">
                          <div className="text-purple-100 text-sm font-semibold mb-1">
                            {file.fileName || 'Inline Style'}
                          </div>
                          <div className="text-purple-300 text-xs font-mono truncate">
                            {file.url}
                          </div>
                        </div>
                        <div className="text-xs text-purple-400 ml-4">
                          {file.size}
                        </div>
                      </div>
                      {file.status === 'failed' ? (
                        <div className="text-red-300 text-xs mt-2">
                          ✗ Failed to load: {file.error}
                        </div>
                      ) : (
                        <div className="flex gap-4 text-sm mt-2">
                          <span className="text-purple-300">
                            <span className="font-semibold">{file.fontFaceCount}</span> @font-face
                          </span>
                          <span className="text-green-300">
                            <span className="font-semibold">{file.fontFamilyCount}</span> font-family
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
