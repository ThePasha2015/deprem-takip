module.exports = (req, res) => {
    // SSE başlıkları
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // İstemciye bağlantının açık olduğunu bildir
    res.write('data: {"type": "connected", "message": "Gerçek zamanlı bağlantı kuruldu"}\n\n');
    
    console.log('SSE bağlantısı açıldı');
    
    // Rastgele bir ID oluştur
    const clientId = Date.now() + Math.random().toString(36).substring(2, 15);
    
    // Aktif kullanıcı sayısı
    const activeUsers = Math.floor(Math.random() * 30) + 20;
    
    // Simüle edilmiş güncellemeler gönder
    let counter = 0;
    
    const sendUpdate = () => {
      // Güncellenmiş zaman gönder
      const updateMessage = {
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        activeUsers: activeUsers + Math.floor(Math.random() * 5),
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
  };