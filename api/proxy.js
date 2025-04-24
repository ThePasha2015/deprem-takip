const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

// Kandilli Rasathanesi URL'si
const KANDILLI_URL = 'http://www.koeri.boun.edu.tr/scripts/lst2.asp';

module.exports = async (req, res) => {
  // CORS başlıklarını ayarla
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // OPTIONS isteklerini yanıtla (CORS preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    // Kandilli'den verileri al
    const response = await axios.get(KANDILLI_URL, {
      responseType: 'arraybuffer'  // Windows-1254 (Türkçe) karakter seti için
    });
    
    // Türkçe karakterler için karakter setini dönüştür
    const html = iconv.decode(response.data, 'windows-1254');
    
    // HTML'i parse et ve pre tag'i içindeki deprem verilerini çıkar
    const $ = cheerio.load(html);
    const earthquakeData = $('pre').text();
    
    // Deprem verilerini satırlara böl ve işle
    const earthquakes = parseEarthquakeData(earthquakeData);
    
    // JSON olarak yanıt döndür
    res.status(200).json({
      success: true,
      count: earthquakes.length,
      earthquakes: earthquakes
    });
  } catch (error) {
    console.error('Kandilli verisi alınırken hata:', error);
    res.status(500).json({
      success: false,
      error: 'Kandilli Rasathanesi verileri alınırken bir hata oluştu'
    });
  }
};

// Kandilli verilerini parse et
function parseEarthquakeData(data) {
  const lines = data.split('\n');
  const earthquakes = [];
  
  // Başlık satırlarını atla, veri satırlarını işle
  let dataStarted = false;
  
  for (let line of lines) {
    line = line.trim();
    
    // Veri satırlarını işlemeye başla
    if (line.includes('Tarih') && line.includes('Saat') && line.includes('Enlem') && line.includes('Boylam')) {
      dataStarted = true;
      continue;
    }
    
    // Veri satırlarını işle
    if (dataStarted && line.length > 10) {
      try {
        // Örnek format:
        // 2023.12.24 00:23:43  37.0703   27.6147      8.3  -.- 2.3  -.- BODRUM KORFEZI (AKDENIZ) İlksel
        const parts = line.split(/\s+/);
        
        if (parts.length >= 9) {
          const dateStr = parts[0]; // 2023.12.24
          const timeStr = parts[1]; // 00:23:43
          const latitude = parseFloat(parts[2]);
          const longitude = parseFloat(parts[3]);
          const depth = parseFloat(parts[4]);
          const magnitude = parseFloat(parts[6]);
          
          // Yer bilgisini topla
          let location = '';
          for (let i = 8; i < parts.length; i++) {
            if (parts[i] === 'İlksel' || parts[i] === 'REVIZE') break;
            location += parts[i] + ' ';
          }
          location = location.trim();
          
          // Tarih düzeltme
          const dateParts = dateStr.split('.');
          const formattedDate = `${dateParts[0]}-${dateParts[1]}-${dateParts[2]}T${timeStr}`;
          
          // Geçerli veriler kontrol ediliyor
          if (!isNaN(latitude) && !isNaN(longitude) && !isNaN(magnitude)) {
            earthquakes.push({
              id: `eq_${dateStr.replace(/\./g, '')}_${timeStr.replace(/:/g, '')}_${latitude.toFixed(2)}_${longitude.toFixed(2)}`,
              date: formattedDate,
              title: location,
              mag: magnitude,
              depth: isNaN(depth) ? 0 : depth,
              lat: latitude,
              lng: longitude
            });
          }
        }
      } catch (e) {
        console.warn('Satır işlenemedi:', line, e);
      }
    }
  }
  
  return earthquakes;
}