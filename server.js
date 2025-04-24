const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS ayarları
app.use(cors());

// Statik dosyalar için public klasörünü kullan
app.use(express.static('public'));

// Kandilli Rasathanesi URL'si
const KANDILLI_URL = 'http://www.koeri.boun.edu.tr/scripts/lst2.asp';

// Önbellek
let earthquakeCache = {
  data: null,
  timestamp: 0,
  expiresIn: 5 * 60 * 1000 // 5 dakika
};

// Proxy API endpoint
app.get('/api/proxy', async (req, res) => {
  try {
    console.log('Kandilli verisi isteniyor...');
    
    // Önbellekten veri kontrolü
    const now = Date.now();
    if (earthquakeCache.data && now - earthquakeCache.timestamp < earthquakeCache.expiresIn) {
      console.log('Önbellekten veri kullanılıyor...');
      return res.json({
        success: true,
        count: earthquakeCache.data.length,
        earthquakes: earthquakeCache.data,
        source: 'cache'
      });
    }
    
    // Gerçek Kandilli verilerini çek
    console.log('Kandilli\'den yeni veri çekiliyor...');
    const response = await axios.get(KANDILLI_URL, {
      responseType: 'arraybuffer'  // Türkçe karakterler için
    });
    
    // Türkçe karakterler için karakter setini dönüştür
    const html = iconv.decode(response.data, 'windows-1254');
    
    // HTML'i parse et
    const $ = cheerio.load(html);
    
    // Pre tag içindeki deprem verilerini al
    const rawText = $('pre').text();
    
    // Deprem verilerini işle
    const earthquakes = parseKandilliData(rawText);
    
    // Önbelleğe al
    earthquakeCache.data = earthquakes;
    earthquakeCache.timestamp = now;
    
    // JSON olarak yanıt döndür
    res.json({
      success: true,
      count: earthquakes.length,
      earthquakes: earthquakes,
      source: 'api'
    });
  } catch (error) {
    console.error('Hata:', error);
    
    // Önbellekte veri varsa, hata durumunda onu kullan
    if (earthquakeCache.data) {
      console.log('Hata oluştu, önbellekten veri kullanılıyor...');
      return res.json({
        success: true,
        count: earthquakeCache.data.length,
        earthquakes: earthquakeCache.data,
        source: 'cache_fallback'
      });
    }
    
    // Önbellekte veri yoksa hata döndür
    res.status(500).json({
      success: false,
      error: 'Kandilli Rasathanesi verileri alınamadı: ' + error.message
    });
  }
});

// Gerçek zamanlı API endpoint (SSE)
app.get('/api/realtime', (req, res) => {
  // SSE başlıkları
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // İstemciye bağlantının açık olduğunu bildir
  res.write('data: {"type": "connected", "message": "Gerçek zamanlı bağlantı kuruldu"}\n\n');
  
  console.log('SSE bağlantısı açıldı');
  
  // Rastgele bir ID oluştur
  const clientId = Date.now() + Math.random().toString(36).substring(2, 15);
  
  // Aktif kullanıcı sayısı (gerçek uygulamada bir veritabanı veya Redis kullanılabilir)
  const activeUsers = Math.floor(Math.random() * 30) + 20;
  
  // Simüle edilmiş güncellemeler gönder
  let counter = 0;
  
  const sendUpdate = () => {
    // Güncellenmiş zaman gönder
    const updateMessage = {
      type: 'heartbeat',
      timestamp: new Date().toISOString(),
      activeUsers: activeUsers + Math.floor(Math.random() * 5), // Küçük dalgalanmalar ekle
      counter: counter++
    };
    
    res.write(`data: ${JSON.stringify(updateMessage)}\n\n`);
  };
  
  // İlk güncellemeyi hemen gönder
  sendUpdate();
  
  // 30 saniyede bir güncelleme gönder
  const interval = setInterval(sendUpdate, 30000);
  
  // Bağlantı kapandığında interval'i temizle
  req.on('close', () => {
    clearInterval(interval);
    console.log('SSE bağlantısı kapandı');
  });
});

// Kandilli verilerini parse et
function parseKandilliData(text) {
  const earthquakes = [];
  const lines = text.split('\n');
  
  // Başlık satırlarını atla
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
              id: `eq_${dateStr.replace(/\./g, '')}_${timeStr.replace(/:/g, '')}`,
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

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});