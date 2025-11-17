const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (CSS)
app.use(express.static(path.join(__dirname, 'public')));

const YOUR_SCHEME = "qsif Equity Long-Short Fund - Direct - Growth";
const UNITS = 99995;
const PRINCIPAL = 1000000;

// Fetch function (for fallback)
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", (err) => reject(err));
  });
}

// POST request function for ASP.NET postback
function postURL(url, formData, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(formData).toString();
    
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.qsif.com/NAV/latestnav',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers
      }
    };
    
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Status ${res.statusCode}: ${res.statusMessage}`));
        }
      });
    });
    
    req.on("error", (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

// Generic multi-page NAV data fetcher - handles any number of pages
async function fetchAllNAVData() {
  try {
    console.log('🔄 Fetching NAV data from QSIF website...');
    
    let allSchemes = [];
    let currentPage = 1;
    let hasMorePages = true;
    let currentHtml = await fetchURL("https://www.qsif.com/NAV/latestnav");
    
    // Fetch all pages in a loop
    while (hasMorePages && currentPage <= 5) { // Safety limit: max 5 pages
      // Parse current page
      const pageSchemes = parseNAVHtml(currentHtml);
      console.log(`✅ Page ${currentPage}: Fetched ${pageSchemes.length} schemes`);
      
      if (pageSchemes.length > 0) {
        // Check for duplicates - if we're getting the same schemes, stop
        const isDuplicate = pageSchemes.some(newScheme => 
          allSchemes.some(existingScheme => 
            existingScheme.name === newScheme.name && 
            existingScheme.option === newScheme.option &&
            existingScheme.nav === newScheme.nav
          )
        );
        
        if (isDuplicate && currentPage > 1) {
          console.log(`⚠️ Duplicate data detected - stopping to prevent infinite loop`);
          hasMorePages = false;
          break;
        }
        
        allSchemes.push(...pageSchemes);
        console.log(`📋 Page ${currentPage} schemes:`, pageSchemes.map(s => `${s.name} (${s.option})`).join(', '));
      }
      
      // Check if there's a Next button (indicates more pages)
      const hasNextButton = currentHtml.includes('>Next<');
      
      if (hasNextButton) {
        console.log(`📄 Page ${currentPage + 1} detected! Fetching...`);
        
        // Extract form data for ASP.NET postback
        const viewStateMatch = currentHtml.match(/<input[^>]+name="__VIEWSTATE"[^>]+value="([^"]*)"[^>]*>/);
        const eventValidationMatch = currentHtml.match(/<input[^>]+name="__EVENTVALIDATION"[^>]+value="([^"]*)"[^>]*>/);
        const viewStateGenMatch = currentHtml.match(/<input[^>]+name="__VIEWSTATEGENERATOR"[^>]+value="([^"]*)"[^>]*>/);
        
        // Find the Next button's __EVENTTARGET value
        let eventTarget = null;
        const nextButtonPatterns = [
          /href="javascript:__doPostBack\('([^']+)',''\)"[^>]*>Next</i,
          /href="javascript:__doPostBack\(&#39;([^&#]+)&#39;,&#39;&#39;\)"[^>]*>Next</i,
          /javascript:__doPostBack\('([^']+)',''\)[^>]*>Next</i,
          /javascript:__doPostBack\(&#39;([^&#]+)&#39;,&#39;&#39;\)[^>]*>Next</i,
          /<a[^>]*href="javascript:__doPostBack\('([^']+)'[^>]*>Next<\/a>/i,
        ];
        
        for (const pattern of nextButtonPatterns) {
          const match = currentHtml.match(pattern);
          if (match) {
            eventTarget = match[1];
            console.log(`🎯 Found Next button target: ${eventTarget}`);
            break;
          }
        }
        
        // Fallback: search more broadly in the HTML around "Next"
        if (!eventTarget) {
          const nextContext = currentHtml.substring(
            Math.max(0, currentHtml.indexOf('>Next<') - 200),
            currentHtml.indexOf('>Next<') + 50
          );
          const fallbackMatch = nextContext.match(/__doPostBack\('([^']+)'/);
          if (fallbackMatch) {
            eventTarget = fallbackMatch[1];
            console.log(`🎯 Found Next button target (fallback): ${eventTarget}`);
          }
        }
        
        if (viewStateMatch && eventValidationMatch) {
          try {
            console.log(`🚀 Making POST request for page ${currentPage + 1}...`);
            
            // Add a small delay to avoid overwhelming the server
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Build form data with ALL hidden fields from the page
            const formData = {
              '__EVENTTARGET': eventTarget,
              '__EVENTARGUMENT': '',
              '__VIEWSTATE': viewStateMatch[1],
              '__EVENTVALIDATION': eventValidationMatch[1]
            };
            
            if (viewStateGenMatch) {
              formData['__VIEWSTATEGENERATOR'] = viewStateGenMatch[1];
            }
            
            // Extract ALL other hidden input fields from the form
            const hiddenInputs = currentHtml.matchAll(/<input[^>]+type=["']?hidden["']?[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi);
            for (const match of hiddenInputs) {
              const name = match[1];
              const value = match[2];
              // Don't override the ones we already set
              if (!formData[name] && !['__EVENTTARGET', '__EVENTARGUMENT'].includes(name)) {
                formData[name] = value;
              }
            }
            
            // Also try alternate format for hidden inputs
            const hiddenInputs2 = currentHtml.matchAll(/<input[^>]+name=["']([^"']+)["'][^>]*type=["']?hidden["']?[^>]*value=["']([^"']*)["'][^>]*>/gi);
            for (const match of hiddenInputs2) {
              const name = match[1];
              const value = match[2];
              if (!formData[name] && !['__EVENTTARGET', '__EVENTARGUMENT'].includes(name)) {
                formData[name] = value;
              }
            }
            
            console.log(`📝 Posting with target: ${eventTarget}`);
            console.log(`📝 Total form fields: ${Object.keys(formData).length}`);
            console.log(`📝 Form fields: ${Object.keys(formData).join(', ')}`);
            
            const responseHtml = await postURL('https://www.qsif.com/NAV/latestnav', formData);
            
            if (responseHtml && responseHtml.length > 100) {
              // Check what page indicator we got back
              const responseHasNext = responseHtml.includes('>Next<');
              const responseHasPrev = responseHtml.includes('>Prev<');
              console.log(`📄 Response has Next: ${responseHasNext}, has Prev: ${responseHasPrev}`);
              
              // Parse the schemes from response to see if they're different
              const responseSchemes = parseNAVHtml(responseHtml);
              console.log(`📊 Response contains ${responseSchemes.length} schemes`);
              
              if (responseSchemes.length > 0) {
                console.log(`📋 First scheme in response: ${responseSchemes[0].name} (${responseSchemes[0].option})`);
                
                // Check if this is different from current page
                const sameAsCurrentPage = responseSchemes.length === pageSchemes.length &&
                  responseSchemes[0].name === pageSchemes[0].name;
                
                if (sameAsCurrentPage) {
                  console.log(`⚠️ WARNING: Response looks like same page - POST may have failed`);
                  hasMorePages = false;
                } else {
                  // IMPORTANT: Update currentHtml with the new page response
                  currentHtml = responseHtml;
                  currentPage++;
                  console.log(`✅ Successfully moved to page ${currentPage}`);
                }
              } else {
                console.log('⚠️ Response has no schemes');
                hasMorePages = false;
              }
            } else {
              console.log('⚠️ Received empty response');
              hasMorePages = false;
            }
            
          } catch (pageError) {
            console.log(`❌ Failed to fetch page ${currentPage + 1}:`, pageError.message);
            console.log(`⚠️ Stopping pagination - continuing with ${allSchemes.length} schemes from ${currentPage} page(s)`);
            hasMorePages = false;
          }
        } else {
          console.log('❌ Could not extract form data for pagination');
          hasMorePages = false;
        }
      } else {
        // No Next button - we've reached the last page
        console.log(`ℹ️ No more pages after page ${currentPage}`);
        hasMorePages = false;
      }
    }
    
    console.log(`🎉 TOTAL: ${allSchemes.length} schemes fetched from ${currentPage} page(s)`);
    return allSchemes;

  } catch (error) {
    console.error('❌ Error fetching NAV data:', error);
    throw error;
  }
}

// Helper function to parse NAV data from HTML
function parseNAVHtml(html) {
  const rows = [...html.matchAll(
    /<tr>\s*<td>\s*(.*?)\s*<\/td>\s*<td>\s*(.*?)\s*<\/td>\s*<td>\s*(.*?)\s*<\/td>\s*<td class="rightAlign">\s*(.*?)\s*<\/td>/g
  )];

  if (rows.length === 0) {
    return [];
  }

  return rows.map(([, date, name, option, nav]) => ({
    date,
    name: name.trim(),
    option: option.trim(),
    nav: parseFloat(nav),
  }));
}

// Template rendering function
function renderTemplate(templateName, data) {
  const templatePath = path.join(__dirname, 'views', `${templateName}.html`);
  let template = fs.readFileSync(templatePath, 'utf-8');
  
  // Replace all placeholders
  for (const [key, value] of Object.entries(data)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    template = template.replace(regex, value);
  }
  
  return template;
}

app.get("/", async (req, res) => {
  try {
    console.log("==================================================");
    console.log("New request received for NAV dashboard");
    const schemes = await fetchAllNAVData();

    if (!schemes.length) throw new Error("No NAV data found");

    console.log(`\n🔍 Looking for your scheme: "${YOUR_SCHEME}"`);
    
    const yourSchemeEntry = schemes.find(
      (s) => s.name === YOUR_SCHEME && s.option === "Growth"
    );

    if (!yourSchemeEntry) {
      console.log('❌ Your scheme not found!');
      console.log('\n📋 Available schemes:');
      schemes.forEach((s, i) => {
        console.log(`   ${i+1}. ${s.name} (${s.option}) - NAV: ₹${s.nav} [${s.date}]`);
      });
      
      const schemesList = schemes.map(s => 
        `<li>${s.name} (${s.option}) - NAV: ₹${s.nav} [${s.date}]</li>`
      ).join('');
      
      const html = renderTemplate('error', {
        schemeName: `${YOUR_SCHEME} (Growth)`,
        totalSchemes: schemes.length,
        schemesList: schemesList
      });
      
      res.send(html);
      return;
    }

    console.log(`✅ Found your scheme! NAV: ₹${yourSchemeEntry.nav}`);

    const yourCurrentValue = yourSchemeEntry.nav * UNITS;
    const yourGainLoss = yourCurrentValue - PRINCIPAL;
    const yourReturnPercent = (yourGainLoss / PRINCIPAL) * 100;

    const otherSchemes = schemes.filter(
      (s) => !(s.name === YOUR_SCHEME && s.option === "Growth")
    );

    const comparison = otherSchemes.map((s) => {
      const value = s.nav * UNITS;
      const gainLoss = value - PRINCIPAL;
      const ret = (gainLoss / PRINCIPAL) * 100;
      return {
        name: `${s.name} (${s.option})`,
        nav: s.nav,
        value,
        gainLoss,
        returnPercent: ret,
      };
    });

    // Chart data
    const chartLabels = [YOUR_SCHEME + " (Growth)", ...comparison.map(s => s.name)];
    const chartValues = [yourCurrentValue, ...comparison.map(s => s.value)];

    // Random colors for each bar
    const chartColors = chartLabels.map(() => {
      const r = Math.floor(Math.random() * 200) + 30;
      const g = Math.floor(Math.random() * 200) + 30;
      const b = Math.floor(Math.random() * 200) + 30;
      return `rgb(${r},${g},${b})`;
    });

    // Build comparison cards HTML
    const comparisonCards = comparison.map(s => `
      <dl class="card">
        <dt>${s.name}</dt>
        <dd>NAV: ₹${s.nav.toFixed(4)}</dd>
        <dd>Value: ₹${s.value.toFixed(2)}</dd>
        <dd class="gain ${s.gainLoss >= 0 ? 'positive' : 'negative'}">Gain/Loss: ₹${s.gainLoss.toFixed(2)}</dd>
        <dd class="gain ${s.gainLoss >= 0 ? 'positive' : 'negative'}">Return: ${s.returnPercent.toFixed(2)}%</dd>
      </dl>
    `).join('');

    // Render dashboard template
    const html = renderTemplate('dashboard', {
      schemeName: `${YOUR_SCHEME} (Growth)`,
      date: yourSchemeEntry.date,
      nav: yourSchemeEntry.nav.toFixed(4),
      units: UNITS,
      currentValue: yourCurrentValue.toFixed(2),
      gainLoss: yourGainLoss.toFixed(2),
      returnPercent: yourReturnPercent.toFixed(2),
      gainClass: yourGainLoss >= 0 ? 'positive' : 'negative',
      comparisonCards: comparisonCards,
      chartLabels: JSON.stringify(chartLabels),
      chartValues: JSON.stringify(chartValues),
      chartColors: JSON.stringify(chartColors)
    });

    res.send(html);

  } catch (error) {
    console.error('Error:', error);
    res.send(`<h1>Error: ${error.message}</h1>`);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Dashboard available at: http://localhost:${PORT}`);
});
