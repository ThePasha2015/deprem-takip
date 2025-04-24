document.addEventListener('DOMContentLoaded', function() {
    // Sabit değişkenler
    const API_URL = '/api/proxy';  // Yerel API endpoint'i
    const REALTIME_URL = '/api/realtime'; // Gerçek zamanlı API endpoint'i
    const REFRESH_INTERVAL = 300000; // 5 dakika (milisaniye)
    const DEFAULT_MIN_MAGNITUDE = 3.0;
    
    // API önbelleği
    const apiCache = {
        data: null,
        timestamp: 0,
        maxAge: 5 * 60 * 1000, // 5 dakika (milisaniye)
        
        isFresh: function() {
            return this.data && (Date.now() - this.timestamp < this.maxAge);
        },
        
        set: function(data) {
            this.data = data;
            this.timestamp = Date.now();
        },
        
        get: function() {
            return this.isFresh() ? this.data : null;
        }
    };
    
    // Bildirim geçmişi
    const notificationHistory = [];
    
    // Durum değişkenleri
    let map = null;
    let markerClusterGroup = null;
    let earthquakeMarkers = [];
    let allEarthquakes = [];
    let filteredEarthquakes = [];
    let displayedEarthquakes = 0;
    const EARTHQUAKES_PER_PAGE = 10;
    let magnitudeChart = null;
    let sseConnection = null;
    
    // Kullanıcı tercihleri
    const userPreferences = {
        notificationsEnabled: false,
        minMagnitude: DEFAULT_MIN_MAGNITUDE,
        locationFilter: '',
        
        load: function() {
            try {
                const savedPrefs = localStorage.getItem('earthquakePreferences');
                if (savedPrefs) {
                    const prefs = JSON.parse(savedPrefs);
                    this.notificationsEnabled = prefs.notificationsEnabled || false;
                    this.minMagnitude = prefs.minMagnitude || DEFAULT_MIN_MAGNITUDE;
                    this.locationFilter = prefs.locationFilter || '';
                }
            } catch (error) {
                console.error('Kullanıcı tercihleri yüklenemedi:', error);
            }
        },
        
        save: function() {
            try {
                localStorage.setItem('earthquakePreferences', JSON.stringify({
                    notificationsEnabled: this.notificationsEnabled,
                    minMagnitude: this.minMagnitude,
                    locationFilter: this.locationFilter
                }));
            } catch (error) {
                console.error('Kullanıcı tercihleri kaydedilemedi:', error);
            }
        }
    };
    
    // Sayfa başlangıcında tercihleri yükle
    userPreferences.load();
    
    // Toast mesajı göster
    function showToast(message, type = 'success') {
        try {
            // Bootstrap Toast API'yi kullan
            const toastId = 'toast-' + Date.now();
            const toastHTML = `
                <div id="${toastId}" class="toast align-items-center text-white bg-${type} border-0 position-fixed bottom-0 end-0 m-3" role="alert" aria-live="assertive" aria-atomic="true">
                    <div class="d-flex">
                        <div class="toast-body">
                            ${message}
                        </div>
                        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Kapat"></button>
                    </div>
                </div>
            `;
            
            const toastContainer = document.createElement('div');
            toastContainer.innerHTML = toastHTML;
            document.body.appendChild(toastContainer.firstChild);
            
            // Bootstrap Toast'u görüntüle
            const toastElement = document.getElementById(toastId);
            if (toastElement && window.bootstrap && window.bootstrap.Toast) {
                const toast = new bootstrap.Toast(toastElement, { delay: 5000 });
                toast.show();
                
                // Toast kaybolduğunda DOM'dan kaldır
                toastElement.addEventListener('hidden.bs.toast', function() {
                    if (toastElement.parentNode) {
                        toastElement.parentNode.removeChild(toastElement);
                    }
                });
            } else {
                // Bootstrap Toast kullanılamıyorsa basit bir bildirim göster
                console.log(`Toast (${type}): ${message}`);
                
                // Basit bir alternatif bildirim
                const simpleToast = document.createElement('div');
                simpleToast.style.cssText = `
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    background-color: ${type === 'success' ? '#28a745' : type === 'danger' ? '#dc3545' : type === 'warning' ? '#ffc107' : '#17a2b8'};
                    color: white;
                    padding: 15px 25px;
                    border-radius: 5px;
                    z-index: 9999;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
                `;
                simpleToast.textContent = message;
                document.body.appendChild(simpleToast);
                
                // 5 saniye sonra kaldır
                setTimeout(() => {
                    if (simpleToast.parentNode) {
                        simpleToast.parentNode.removeChild(simpleToast);
                    }
                }, 5000);
            }
        } catch (error) {
            console.error('Toast gösterme hatası:', error);
            console.log(`Toast (${type}): ${message}`);
        }
    }
    
    // Hata mesajı göster
    function showErrorMessage(message) {
        console.error('Hata:', message);
        showToast(message, 'danger');
    }
    
    // Bildirim toggle'ını güncelle
    function updateNotificationToggle() {
        try {
            const toggleElement = document.getElementById('notificationToggle');
            if (!toggleElement) return;
            
            if (userPreferences.notificationsEnabled) {
                toggleElement.innerHTML = '<i class="fas fa-bell me-2 text-white"></i><span class="text-white d-none d-md-inline">Bildirimler Açık</span>';
            } else {
                toggleElement.innerHTML = '<i class="fas fa-bell-slash me-2 text-white"></i><span class="text-white d-none d-md-inline">Bildirimler Kapalı</span>';
            }
        } catch (error) {
            console.error('Bildirim toggle güncelleme hatası:', error);
        }
    }
    
    // Haritayı başlat
    function initializeMap() {
        try {
            const mapContainer = document.getElementById('mapContainer');
            if (!mapContainer) {
                console.error('Harita konteyneri bulunamadı');
                return;
            }
            
            // Harita oluştur
            map = L.map('mapContainer').setView([39.0, 35.9], 6);
            
            // Harita katmanı
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            }).addTo(map);
            
            // İşaretçi kümelemesi için grup oluştur
            markerClusterGroup = L.markerClusterGroup({
                showCoverageOnHover: false,
                maxClusterRadius: 50,
                iconCreateFunction: function(cluster) {
                    const count = cluster.getChildCount();
                    let size, className;
                    
                    if (count < 10) {
                        size = 'small';
                        className = 'marker-cluster-small';
                    } else if (count < 100) {
                        size = 'medium';
                        className = 'marker-cluster-medium';
                    } else {
                        size = 'large';
                        className = 'marker-cluster-large';
                    }
                    
                    return L.divIcon({
                        html: '<div><span>' + count + '</span></div>',
                        className: 'marker-cluster ' + className,
                        iconSize: L.point(40, 40)
                    });
                }
            });
            
            map.addLayer(markerClusterGroup);
            
            // Fay hatları katmanını ekle
            addFaultLinesLayer();
            
            // Harita bilgi kutusunu göster/gizle
            const mapInfo = document.getElementById('mapInfo');
            if (mapInfo) {
                map.on('mouseover', function() {
                    mapInfo.classList.remove('d-none');
                });
                
                map.on('mouseout', function() {
                    mapInfo.classList.add('d-none');
                });
            }
            
            console.log('Harita başarıyla başlatıldı');
        } catch (error) {
            console.error('Harita başlatılamadı:', error);
            showErrorMessage('Harita yüklenemedi. Lütfen sayfayı yenileyin.');
        }
    }
    
    // Fay hatları katmanı ekle (basitleştirilmiş)
    function addFaultLinesLayer() {
        try {
            if (!map) return;
            
            // Türkiye'deki ana fay hatları (basitleştirilmiş koordinatlar)
            const faultLines = [
                // Kuzey Anadolu Fay Hattı
                [
                    [40.8, 27.5], [40.7, 28.2], [40.6, 29.1], [40.7, 30.0], 
                    [40.8, 31.0], [40.9, 32.0], [41.0, 33.0], [41.1, 34.0],
                    [41.0, 35.0], [40.7, 36.0], [40.3, 37.0], [40.0, 38.0],
                    [39.7, 39.0], [39.5, 40.0], [39.3, 41.0], [39.2, 42.0]
                ],
                // Doğu Anadolu Fay Hattı
                [
                    [38.5, 38.0], [38.2, 37.5], [37.8, 37.0], [37.5, 36.5],
                    [37.2, 36.2], [37.0, 36.0], [36.7, 35.8], [36.5, 35.6]
                ],
                // Batı Anadolu Fay Hatları
                [
                    [38.6, 27.0], [38.7, 27.5], [38.8, 28.0], [38.9, 28.5], [39.0, 29.0]
                ],
                // Ege Graben Sistemi
                [
                    [37.8, 27.2], [38.0, 27.4], [38.2, 27.6], [38.4, 27.8], [38.6, 28.0]
                ]
            ];
            
            // Fay hatları katmanı
            const faultLayer = L.layerGroup();
            
            // Fay hatlarını ekle
            faultLines.forEach((line, index) => {
                const polyline = L.polyline(line, {
                    color: '#ff0000',
                    weight: 2,
                    opacity: 0.7,
                    dashArray: '5, 5',
                    className: 'fault-line'
                }).addTo(faultLayer);
                
                // Fay hattı adı
                let faultName;
                switch (index) {
                    case 0: faultName = 'Kuzey Anadolu Fay Hattı'; break;
                    case 1: faultName = 'Doğu Anadolu Fay Hattı'; break;
                    case 2: faultName = 'Batı Anadolu Fay Hatları'; break;
                    case 3: faultName = 'Ege Graben Sistemi'; break;
                    default: faultName = 'Fay Hattı'; break;
                }
                
                polyline.bindPopup(`<b>${faultName}</b><br>Türkiye'nin önemli fay hatlarından biri.`);
            });
            
            // Katman kontrolü ekle
            const overlayMaps = {
                "Fay Hatları": faultLayer
            };
            
            L.control.layers(null, overlayMaps, {
                position: 'topright',
                collapsed: false
            }).addTo(map);
            
            // Başlangıçta fay katmanını ekle ama görünmez yap
            faultLayer.addTo(map);
            
            console.log('Fay hatları katmanı eklendi');
        } catch (error) {
            console.error('Fay hatları eklenirken hata oluştu:', error);
        }
    }
    
    // Deprem verilerini getir
    async function fetchEarthquakeData(forceRefresh = false) {
        updateApiStatus('checking');
        
        // Önbellekten veri kontrolü
        if (!forceRefresh && apiCache.isFresh()) {
            console.log('Önbellekten veri kullanılıyor');
            processEarthquakeData(apiCache.get());
            updateApiStatus('success');
            return;
        }
        
        try {
            const loadingSpinner = document.getElementById('loadingSpinner');
            if (loadingSpinner) loadingSpinner.style.display = 'flex';
            
            console.log('Kandilli Rasathanesi deprem verileri alınıyor...');
            
            const response = await fetch(API_URL);
            
            if (!response.ok) {
                throw new Error(`API yanıt hatası: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('API veri hatası: ' + (data.error || 'Bilinmeyen hata'));
            }
            
            // Deprem verilerini önbelleğe al
            apiCache.set(data.earthquakes);
            
            // Verileri işle
            processEarthquakeData(data.earthquakes);
            updateApiStatus('success', data.count);
        } catch (error) {
            console.error('Veri getirme hatası:', error);
            updateApiStatus('error', error.message);
            showErrorMessage('Deprem verileri alınamadı: ' + error.message);
        } finally {
            const loadingSpinner = document.getElementById('loadingSpinner');
            if (loadingSpinner) loadingSpinner.style.display = 'none';
        }
    }
    
    // API durumunu güncelle
    function updateApiStatus(status, message = '') {
        const statusElement = document.getElementById('apiStatus');
        if (!statusElement) return;
        
        switch (status) {
            case 'checking':
                statusElement.className = 'api-status bg-secondary text-white';
                statusElement.innerHTML = '<i class="fas fa-sync fa-spin me-2"></i>Kandilli Verileri Kontrol Ediliyor...';
                statusElement.style.display = 'block';
                statusElement.style.opacity = '1';
                break;
                
            case 'success':
                statusElement.className = 'api-status bg-success text-white';
                statusElement.innerHTML = `<i class="fas fa-check-circle me-2"></i>${message ? `${message} Deprem Verisi Alındı` : 'Veriler Alındı'}`;
                
                // 5 saniye sonra gizle
                setTimeout(() => {
                    statusElement.style.opacity = '0';
                    setTimeout(() => {
                        statusElement.style.display = 'none';
                    }, 500);
                }, 5000);
                break;
                
            case 'error':
                statusElement.className = 'api-status bg-danger text-white';
                statusElement.innerHTML = `<i class="fas fa-exclamation-circle me-2"></i>Bağlantı Hatası: ${message}`;
                statusElement.style.display = 'block';
                statusElement.style.opacity = '1';
                break;
        }
    }
    
    // Deprem verilerini işle
    function processEarthquakeData(earthquakes) {
        console.log('İşlenecek deprem verileri:', earthquakes);
        
        if (!Array.isArray(earthquakes)) {
            console.error('Deprem verileri bir dizi değil:', earthquakes);
            showErrorMessage('Deprem verileri geçersiz formatta.');
            return;
        }
        
        // Tüm depremleri işle ve sakla
        allEarthquakes = earthquakes.map(eq => {
            // Tarih alanı kontrol
            let eqDate;
            try {
                eqDate = new Date(eq.date);
                if (isNaN(eqDate.getTime())) {
                    throw new Error('Geçersiz tarih');
                }
            } catch (e) {
                console.warn('Geçersiz tarih formatı:', eq.date);
                eqDate = new Date(); // Geçersiz tarih için şu anki zamanı kullan
            }
            
            return {
                id: eq.id || `eq_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                date: eqDate,
                title: eq.title || 'Bilinmeyen Konum',
                mag: parseFloat(eq.mag) || 0,
                depth: parseFloat(eq.depth) || 0,
                lat: parseFloat(eq.lat) || 0,
                lng: parseFloat(eq.lng) || 0
            };
        });
        
        console.log('İşlenen deprem sayısı:', allEarthquakes.length);
        
        // Depremleri tarihe göre sırala (en yeni en üstte)
        allEarthquakes.sort((a, b) => b.date - a.date);
        
        // Önceki filtre değerlerini uygula
        applyFilters();
        
        // İstatistikleri güncelle
        updateStatistics();
        
        // Grafikleri güncelle
        updateCharts();
        
        // Büyük depremler için bildirim kontrol et
        checkForSignificantEarthquakes();
        
        // Canlı göstergeyi güncelle
        updateLiveIndicator();
    }
    
    // Canlı veri göstergesini güncelle
    function updateLiveIndicator() {
        try {
            const navbar = document.querySelector('.navbar-nav');
            if (!navbar) return;
            
            // Mevcut göstergeyi kontrol et
            let liveIndicator = document.querySelector('.live-indicator');
            
            if (!liveIndicator) {
                // Gösterge yoksa oluştur
                liveIndicator = document.createElement('span');
                liveIndicator.className = 'live-indicator ms-3';
                liveIndicator.innerHTML = '<span class="pulse"></span>Canlı';
                navbar.appendChild(liveIndicator);
            }
            
            // Animasyon efekti
            liveIndicator.classList.add('blink');
            setTimeout(() => {
                liveIndicator.classList.remove('blink');
            }, 1000);
            
            // Son güncelleme bilgisini tooltip olarak ekle
            liveIndicator.title = `Son güncelleme: ${new Date().toLocaleTimeString()}`;
        } catch (error) {
            console.error('Canlı gösterge güncellenirken hata:', error);
        }
    }
    
    // Filtreleri uygula
    function applyFilters() {
        const magnitudeFilterElement = document.getElementById('magnitudeFilter');
        const locationFilterElement = document.getElementById('locationFilter');
        
        const minMagnitude = magnitudeFilterElement ? parseFloat(magnitudeFilterElement.value) || DEFAULT_MIN_MAGNITUDE : DEFAULT_MIN_MAGNITUDE;
        const locationQuery = locationFilterElement ? locationFilterElement.value.trim().toLowerCase() : '';
        
        userPreferences.minMagnitude = minMagnitude;
        userPreferences.locationFilter = locationQuery;
        userPreferences.save();
        
        // Filtreleme
        filteredEarthquakes = allEarthquakes.filter(eq => {
            const passedMagnitudeFilter = eq.mag >= minMagnitude;
            const passedLocationFilter = !locationQuery || (eq.title && eq.title.toLowerCase().includes(locationQuery));
            return passedMagnitudeFilter && passedLocationFilter;
        });
        
        console.log(`Filtreleme sonrası ${filteredEarthquakes.length} deprem kaldı`);
        
        // UI güncelleme
        updateEarthquakeList();
        updateSignificantEarthquakesList();
        updateMapMarkers();
        
        // Filtreleme sonucunu göster
        showToast(`${filteredEarthquakes.length} deprem bulundu`, 'info');
    }
    
    // Deprem listesini güncelle
    function updateEarthquakeList() {
        const container = document.getElementById('earthquakeList');
        if (!container) return;
        
        container.innerHTML = '';
        
        if (filteredEarthquakes.length === 0) {
            container.innerHTML = `
                <div class="alert alert-info">
                    <i class="fas fa-info-circle me-2"></i>Belirtilen kriterlere uygun deprem bulunamadı.
                </div>
            `;
            
            const loadMoreBtn = document.getElementById('loadMoreBtn');
            if (loadMoreBtn) loadMoreBtn.style.display = 'none';
            
            return;
        }
        
        // İlk sayfayı göster
        displayedEarthquakes = 0;
        loadMoreEarthquakes();
    }
    
    // Daha fazla deprem yükle
    function loadMoreEarthquakes() {
        const container = document.getElementById('earthquakeList');
        if (!container) return;
        
        const start = displayedEarthquakes;
        const end = Math.min(start + EARTHQUAKES_PER_PAGE, filteredEarthquakes.length);
        
        for (let i = start; i < end; i++) {
            const eq = filteredEarthquakes[i];
            const formattedDate = formatDate(eq.date);
            
            // Büyüklüğe göre kart rengi belirle
            let magnitudeClass = '';
            let textClass = '';
            if (eq.mag >= 5) {
                magnitudeClass = 'bg-danger';
                textClass = 'text-white';
            } else if (eq.mag >= 4) {
                magnitudeClass = 'bg-warning';
            } else if (eq.mag >= 3) {
                magnitudeClass = 'bg-info';
                textClass = 'text-white';
            } else {
                magnitudeClass = 'bg-secondary';
                textClass = 'text-white';
            }
            
            const eqItem = document.createElement('div');
            eqItem.className = 'earthquake-card card mb-3 border-0 shadow-sm';
            eqItem.innerHTML = `
                <div class="card-body">
                    <div class="d-flex align-items-center">
                        <div class="magnitude-badge ${magnitudeClass} ${textClass} me-3">
                            ${eq.mag.toFixed(1)}
                        </div>
                        <div class="flex-grow-1">
                            <h5 class="card-title">${eq.title}</h5>
                            <div class="d-flex justify-content-between align-items-center">
                                <div class="text-muted small">
                                    <i class="fas fa-calendar-alt me-1"></i>${formattedDate}
                                </div>
                                <div class="text-muted small">
                                    <i class="fas fa-arrow-down me-1"></i>${eq.depth} km
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Depreme tıklandığında haritada göster
            eqItem.addEventListener('click', () => {
                if (map) {
                    map.setView([eq.lat, eq.lng], 9);
                    
                    // İlgili işaretçiyi bul ve göster
                    earthquakeMarkers.forEach(marker => {
                        if (marker.earthquakeId === eq.id) {
                            markerClusterGroup.zoomToShowLayer(marker, () => {
                                marker.openPopup();
                            });
                        }
                    });
                }
            });
            
            container.appendChild(eqItem);
        }
        
        displayedEarthquakes = end;
        
        // Daha fazla deprem varsa "Daha Fazla" butonunu göster
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        if (loadMoreBtn) {
            loadMoreBtn.style.display = displayedEarthquakes < filteredEarthquakes.length ? 'block' : 'none';
        }
    }
    
    // Önemli depremleri güncelle
    function updateSignificantEarthquakesList() {
        const container = document.getElementById('significantEarthquakeList');
        if (!container) return;
        
        container.innerHTML = '';
        
        // 4 ve üzeri büyüklükteki depremler
        const significantEqs = filteredEarthquakes.filter(eq => eq.mag >= 4.0);
        
        if (significantEqs.length === 0) {
            container.innerHTML = `
                <div class="alert alert-info">
                    <i class="fas fa-info-circle me-2"></i>Listelenecek önemli deprem bulunmuyor.
                </div>
            `;
            return;
        }
        
        significantEqs.forEach(eq => {
            const formattedDate = formatDate(eq.date);
            
            // Büyüklüğe göre kart rengi belirle
            const magnitudeClass = eq.mag >= 5 ? 'bg-danger text-white' : 'bg-warning';
            
            const eqItem = document.createElement('div');
            eqItem.className = 'earthquake-card card mb-3 border-0 shadow-sm';
            eqItem.innerHTML = `
                <div class="card-body">
                    <div class="d-flex align-items-center">
                        <div class="magnitude-badge ${magnitudeClass} me-3">
                            ${eq.mag.toFixed(1)}
                        </div>
                        <div class="flex-grow-1">
                            <h5 class="card-title">${eq.title}</h5>
                            <div class="d-flex justify-content-between align-items-center">
                                <div class="text-muted small">
                                    <i class="fas fa-calendar-alt me-1"></i>${formattedDate}
                                </div>
                                <div class="text-muted small">
                                    <i class="fas fa-arrow-down me-1"></i>${eq.depth} km
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Depreme tıklandığında haritada göster
            eqItem.addEventListener('click', () => {
                if (map) {
                    map.setView([eq.lat, eq.lng], 9);
                    
                    // İlgili işaretçiyi bul ve göster
                    earthquakeMarkers.forEach(marker => {
                        if (marker.earthquakeId === eq.id) {
                            markerClusterGroup.zoomToShowLayer(marker, () => {
                                marker.openPopup();
                            });
                        }
                    });
                }
            });
            
            container.appendChild(eqItem);
        });
    }
    
    // Harita işaretçilerini güncelle
    function updateMapMarkers() {
        if (!map || !markerClusterGroup) return;
        
        // Önceki işaretçileri temizle
        markerClusterGroup.clearLayers();
        earthquakeMarkers = [];
        
        // Yeni işaretçileri ekle
        filteredEarthquakes.forEach(eq => {
            try {
                // Büyüklüğe göre renk ve simge belirle
                let markerColor, markerSize, markerIcon;
                
                if (eq.mag >= 5) {
                    markerColor = '#dc3545'; // Kırmızı
                    markerSize = 2.0;
                    markerIcon = 'exclamation-triangle';
                } else if (eq.mag >= 4) {
                    markerColor = '#ffc107'; // Sarı
                    markerSize = 1.6;
                    markerIcon = 'exclamation-circle';
                } else if (eq.mag >= 3) {
                    markerColor = '#17a2b8'; // Mavi
                    markerSize = 1.3;
                    markerIcon = 'circle';
                } else {
                    markerColor = '#6c757d'; // Gri
                    markerSize = 1.0;
                    markerIcon = 'dot-circle';
                }
                
                // Özel simge oluştur
                const customIcon = L.divIcon({
                    html: `<div style="background-color: ${markerColor}; width: ${20 * markerSize}px; height: ${20 * markerSize}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold; border: 2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.3);">${eq.mag.toFixed(1)}</div>`,
                    className: 'custom-earthquake-marker',
                    iconSize: [24 * markerSize, 24 * markerSize],
                    iconAnchor: [12 * markerSize, 12 * markerSize]
                });
                
                // İşaretçi oluştur
                const marker = L.marker([eq.lat, eq.lng], {
                    icon: customIcon,
                    title: `${eq.title} - ${eq.mag.toFixed(1)}`
                });
                
                // Deprem bilgisi popup'ı
                const formattedDate = formatDate(eq.date);
                marker.bindPopup(`
                    <div class="earthquake-popup">
                        <h6>${eq.title}</h6>
                        <table class="table table-sm mb-2">
                            <tr>
                                <td><strong>Büyüklük:</strong></td>
                                <td><span class="badge ${eq.mag >= 5 ? 'bg-danger' : (eq.mag >= 4 ? 'bg-warning' : 'bg-info')}">${eq.mag.toFixed(1)}</span></td>
                            </tr>
                            <tr>
                                <td><strong>Derinlik:</strong></td>
                                <td>${eq.depth} km</td>
                            </tr>
                            <tr>
                                <td><strong>Tarih:</strong></td>
                                <td>${formattedDate}</td>
                            </tr>
                        </table>
                        <div class="mt-2 d-grid">
                            <a href="https://www.google.com/maps/search/?api=1&query=${eq.lat},${eq.lng}" target="_blank" class="btn btn-sm btn-outline-secondary">
                                <i class="fas fa-map-marker-alt me-1"></i>Google Maps'te Göster
                            </a>
                        </div>
                    </div>
                `, {
                    maxWidth: 300
                });
                
                // İşaretçiye ID atama
                marker.earthquakeId = eq.id;
                
                // İşaretçiyi kümeleme grubuna ekle
                markerClusterGroup.addLayer(marker);
                
                // İşaretçiyi diziye ekle
                earthquakeMarkers.push(marker);
            } catch (e) {
                console.error('Harita işaretçisi oluşturma hatası:', e, eq);
            }
        });
        
        console.log('Harita işaretçileri güncellendi:', earthquakeMarkers.length);
    }
    
    // İstatistikleri güncelle
    function updateStatistics() {
        try {
            const now = new Date();
            
            // Son 24 saat
            const last24Hours = allEarthquakes.filter(eq => {
                return (now - new Date(eq.date)) <= 24 * 60 * 60 * 1000;
            });
            
            // Son 7 gün
            const last7Days = allEarthquakes.filter(eq => {
                return (now - new Date(eq.date)) <= 7 * 24 * 60 * 60 * 1000;
            });
            
            // Son 30 gün (tüm API verisi)
            const last30Days = allEarthquakes;
            
            // İstatistik tablolarını doldur
            updateStatisticTab(last24Hours, '24h');
            updateStatisticTab(last7Days, '7d');
            updateStatisticTab(last30Days, '30d');
            
            // Deprem büyüklüğü dağılımı grafiğini güncelle
            updateCharts();
        } catch (error) {
            console.error('İstatistik güncelleme hatası:', error);
        }
    }

    // İstatistik sekmesini güncelle
    function updateStatisticTab(earthquakes, tabId) {
        try {
            // İstatistik değerlerini hesapla
            const total = earthquakes.length;
            const mag3Plus = earthquakes.filter(eq => eq.mag >= 3.0).length;
            const mag4Plus = earthquakes.filter(eq => eq.mag >= 4.0).length;
            const mag5Plus = earthquakes.filter(eq => eq.mag >= 5.0).length;
            
            // En büyük deprem
            let maxEq = {mag: 0, title: 'Veri yok'};
            for (const eq of earthquakes) {
                if (eq.mag > maxEq.mag) {
                    maxEq = eq;
                }
            }
            
            // DOM elemanlarını güvenli şekilde güncelle
            const updateElement = (id, value) => {
                const element = document.getElementById(id);
                if (element) element.textContent = value;
            };
            
            updateElement(`total${tabId}`, total);
            updateElement(`total3plus${tabId}`, mag3Plus);
            updateElement(`total4plus${tabId}`, mag4Plus);
            updateElement(`total5plus${tabId}`, mag5Plus);
            
            // En büyük deprem bilgisini güncelle
            const maxMagElement = document.getElementById(`max${tabId}`);
            if (maxMagElement) {
                maxMagElement.textContent = maxEq.mag.toFixed(1);
                // Büyüklüğe göre renk sınıfı ekle
                maxMagElement.className = 'badge ' + 
                    (maxEq.mag >= 5.0 ? 'bg-danger' : 
                    (maxEq.mag >= 4.0 ? 'bg-warning' : 
                    (maxEq.mag >= 3.0 ? 'bg-info' : 'bg-secondary')));
            }
            
            updateElement(`maxLocation${tabId}`, maxEq.title);
        } catch (error) {
            console.error('İstatistik sekmesi güncellenirken hata:', error, tabId);
        }
    }

    // Grafikleri güncelle
    function updateCharts() {
        try {
            const chartContainer = document.getElementById('chartContainer');
            if (!chartContainer) return;
            
            // Eğer zaten bir grafik varsa temizle
            if (magnitudeChart) {
                magnitudeChart.destroy();
            }
            
            // Büyüklük dağılımı için veri hazırla
            const magnitudeDistribution = {};
            
            // 2.0'dan 6.0'a kadar 0.5 artışlarla kategoriler oluştur
            for (let i = 2.0; i <= 6.0; i += 0.5) {
                magnitudeDistribution[i.toFixed(1)] = 0;
            }
            
            // Her depremi uygun kategoriye ekle
            allEarthquakes.forEach(eq => {
                // En yakın 0.5 değerine yuvarla
                const roundedMag = (Math.round(eq.mag * 2) / 2).toFixed(1);
                
                // Eğer kategori varsa sayacı artır
                if (magnitudeDistribution[roundedMag] !== undefined) {
                    magnitudeDistribution[roundedMag]++;
                } 
                // Eğer kategori yoksa ve 2.0'dan küçükse, 2.0 kategorisine ekle
                else if (eq.mag < 2.0 && magnitudeDistribution['2.0'] !== undefined) {
                    magnitudeDistribution['2.0']++;
                }
                // Eğer kategori yoksa ve 6.0'dan büyükse, 6.0 kategorisine ekle
                else if (eq.mag > 6.0 && magnitudeDistribution['6.0'] !== undefined) {
                    magnitudeDistribution['6.0']++;
                }
            });
            
            // Veriyi grafik için hazırla
            const labels = Object.keys(magnitudeDistribution);
            const data = Object.values(magnitudeDistribution);
            const backgroundColors = labels.map(mag => {
                const magValue = parseFloat(mag);
                if (magValue >= 5) return '#dc3545'; // Kırmızı
                if (magValue >= 4) return '#ffc107'; // Sarı
                if (magValue >= 3) return '#17a2b8'; // Mavi
                return '#6c757d'; // Gri
            });
            
            // Grafiği oluştur
            const ctx = document.createElement('canvas');
            chartContainer.innerHTML = '';
            chartContainer.appendChild(ctx);
            
            magnitudeChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Deprem Sayısı',
                        data: data,
                        backgroundColor: backgroundColors,
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    plugins: {
                        legend: {
                            display: false
                        },
                        title: {
                            display: true,
                            text: 'Deprem Büyüklüğü Dağılımı',
                            color: '#495057',
                            font: {
                                size: 14
                            }
                        },
                        tooltip: {
                            callbacks: {
                                title: function(tooltipItems) {
                                    return `Büyüklük: ${tooltipItems[0].label}`;
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Deprem Sayısı'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Büyüklük (Richter)'
                            }
                        }
                    }
                }
            });
        } catch (error) {
            console.error('Grafik güncellenirken hata:', error);
        }
    }
    
    // Önemli depremler için bildirim kontrol et
    function checkForSignificantEarthquakes() {
        if (!userPreferences.notificationsEnabled) return;
        
        try {
            // Son 1 saatteki büyük depremler (4.0+)
            const now = new Date();
            const oneHourAgo = new Date(now - 60 * 60 * 1000);
            
            const recentSignificantEarthquakes = allEarthquakes.filter(eq => {
                return eq.date >= oneHourAgo && eq.mag >= 4.0;
            });
            
            recentSignificantEarthquakes.forEach(eq => {
                // Eğer bu deprem daha önce bildirim olarak gösterilmediyse
                if (!notificationHistory.includes(eq.id)) {
                    showEarthquakeNotification(eq);
                    notificationHistory.push(eq.id);
                    
                    // Bildirim listesine ekle
                    addToNotificationList(eq);
                }
            });
            
            // Bildirim geçmişini son 50 depremle sınırla
            if (notificationHistory.length > 50) {
                notificationHistory.splice(0, notificationHistory.length - 50);
            }
        } catch (error) {
            console.error('Bildirim kontrolü hatası:', error);
        }
    }
    
    // Deprem bildirimi göster
    function showEarthquakeNotification(earthquake) {
        try {
            // Tarayıcı bildirimleri
            if ('Notification' in window && Notification.permission === 'granted') {
                const formattedDate = formatDate(earthquake.date);
                
                const notification = new Notification('Önemli Deprem Bildirimi', {
                    body: `${earthquake.mag.toFixed(1)} büyüklüğünde deprem\n${earthquake.title}\nTarih: ${formattedDate}`,
                    icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/74/Earthquake_icon.svg/1200px-Earthquake_icon.svg.png'
                });
                
                notification.onclick = function() {
                    window.focus();
                    if (map) map.setView([earthquake.lat, earthquake.lng], 9);
                };
            }
            
            // Sayfa içi bildirim
            const magnitudeClass = earthquake.mag >= 5 ? 'danger' : 'warning';
            showToast(`${earthquake.mag.toFixed(1)} büyüklüğünde deprem: ${earthquake.title}`, magnitudeClass);
        } catch (error) {
            console.error('Bildirim gösterme hatası:', error);
        }
    }
    
    // Bildirim listesine ekle
    function addToNotificationList(earthquake) {
        try {
            const container = document.getElementById('notificationList');
            if (!container) return;
            
            // İlk bildirimde container'ı temizle
            if (container.querySelector('.alert-info')) {
                container.innerHTML = '';
            }
            
            const formattedDate = formatDate(earthquake.date);
            const magnitudeClass = earthquake.mag >= 5 ? 'danger' : 'warning';
            
            const notificationElement = document.createElement('div');
            notificationElement.className = `alert alert-${magnitudeClass} mb-2`;
            notificationElement.innerHTML = `
                <div class="d-flex align-items-center">
                    <span class="pulse"></span>
                    <div>
                        <strong>${earthquake.mag.toFixed(1)}</strong> büyüklüğünde deprem
                        <div class="small">${earthquake.title}</div>
                        <div class="small text-muted">${formattedDate}</div>
                    </div>
                </div>
            `;
            
            // Tıklama ile harita odaklaması
            notificationElement.style.cursor = 'pointer';
            notificationElement.addEventListener('click', () => {
                if (map) map.setView([earthquake.lat, earthquake.lng], 9);
            });
            
            // En üste ekle
            if (container.firstChild) {
                container.insertBefore(notificationElement, container.firstChild);
            } else {
                container.appendChild(notificationElement);
            }
            
            // Maksimum 5 bildirim göster
            const notifications = container.querySelectorAll('.alert');
            if (notifications.length > 5) {
                container.removeChild(notifications[notifications.length - 1]);
            }
        } catch (error) {
            console.error('Bildirim listesi güncelleme hatası:', error);
        }
    }
    
    // Tarih formatla
    function formatDate(date) {
        try {
            if (!(date instanceof Date) || isNaN(date)) {
                return 'Geçersiz Tarih';
            }
            
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.round(diffMs / 60000);
            
            // Son 60 dakika içinde ise "... dakika önce" göster
            if (diffMins < 60) {
                return `${diffMins} dakika önce`;
            }
            
            // Son 24 saat içinde ise "... saat önce" göster
            const diffHours = Math.round(diffMins / 60);
            if (diffHours < 24) {
                return `${diffHours} saat önce`;
            }
            
            // Diğer durumlarda tam tarih göster
            return `${date.toLocaleDateString('tr-TR')} ${date.toLocaleTimeString('tr-TR')}`;
        } catch (error) {
            console.error('Tarih formatlama hatası:', error);
            return 'Bilinmiyor';
        }
    }
    
    // Bildirim izni iste
    function requestNotificationPermission() {
        try {
            if (!('Notification' in window)) {
                showToast('Tarayıcınız bildirimleri desteklemiyor', 'warning');
                return;
            }
            
            if (Notification.permission === 'granted') {
                userPreferences.notificationsEnabled = !userPreferences.notificationsEnabled;
                updateNotificationToggle();
                
                const message = userPreferences.notificationsEnabled ? 
                    'Bildirimler etkinleştirildi' : 
                    'Bildirimler devre dışı bırakıldı';
                    
                showToast(message, userPreferences.notificationsEnabled ? 'success' : 'info');
                userPreferences.save();
                return;
            }
            
            if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        userPreferences.notificationsEnabled = true;
                        updateNotificationToggle();
                        showToast('Bildirimler etkinleştirildi', 'success');
                        userPreferences.save();
                    } else {
                        showToast('Bildirim izni reddedildi', 'warning');
                    }
                });
            } else {
                showToast('Bildirim izni daha önce reddedilmiş. Tarayıcı ayarlarından izin vermeniz gerekiyor.', 'warning');
            }
        } catch (error) {
            console.error('Bildirim izni isteme hatası:', error);
        }
    }
    
    // Gerçek zamanlı bağlantıyı kur
    function initializeRealTimeConnection() {
        try {
            // Daha önce bir bağlantı varsa kapat
            if (sseConnection) {
                sseConnection.close();
            }
            
            // Server-Sent Events bağlantısı kur
            sseConnection = new EventSource(REALTIME_URL);
            
            // Bağlantı kurulduğunda
            sseConnection.onopen = function() {
                console.log('Gerçek zamanlı bağlantı kuruldu');
                showRealtimeBanner(true);
            };
            
            // Mesaj geldiğinde
            sseConnection.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.type === 'connected') {
                        console.log('SSE bağlantısı başarılı:', data.message);
                        showRealtimeBanner(true);
                    } 
                    else if (data.type === 'heartbeat') {
                        updateRealtimeStatus(data);
                    }
                    else if (data.type === 'new_earthquake') {
                        // Yeni deprem verisi geldiğinde
                        handleNewEarthquake(data.earthquake);
                    }
                } catch (e) {
                    console.error('SSE mesajı işlenirken hata:', e);
                }
            };
            
            // Hata durumunda
            sseConnection.onerror = function(error) {
                console.error('SSE bağlantı hatası:', error);
                showRealtimeBanner(false);
                
                // 10 saniye sonra yeniden bağlanmayı dene
                setTimeout(() => {
                    initializeRealTimeConnection();
                }, 10000);
            };
        } catch (error) {
            console.error('Gerçek zamanlı bağlantı kurulurken hata:', error);
        }
    }
    
    // Gerçek zamanlı durum çubuğunu göster/gizle
    function showRealtimeBanner(show) {
        const banner = document.getElementById('realtimeBanner');
        if (!banner) return;
        
        if (show) {
            banner.classList.remove('d-none');
        } else {
            banner.classList.add('d-none');
        }
    }
    
    // Gerçek zamanlı durum bilgilerini güncelle
    function updateRealtimeStatus(data) {
        try {
            // Son güncelleme zamanını göster
            const lastUpdateElement = document.getElementById('lastUpdateTime');
            if (lastUpdateElement) {
                const date = new Date(data.timestamp);
                lastUpdateElement.textContent = `Son güncelleme: ${date.toLocaleTimeString()}`;
            }
            
            // Aktif kullanıcı sayısını güncelle
            const activeUsersElement = document.getElementById('activeUsers');
            if (activeUsersElement) {
                activeUsersElement.textContent = data.activeUsers || 0;
            }
            
            // Banner'ı canlandırma efekti
            const banner = document.getElementById('realtimeBanner');
            if (banner) {
                banner.classList.add('bg-success-pulse');
                setTimeout(() => {
                    banner.classList.remove('bg-success-pulse');
                }, 1000);
            }
        } catch (error) {
            console.error('Gerçek zamanlı durum güncellenirken hata:', error);
        }
    }
    
    // Yeni deprem verisini işle
    function handleNewEarthquake(earthquake) {
        if (!earthquake) return;
        
        // Deprem verisini doğrula
        const newEarthquake = {
            id: earthquake.id || `eq_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            date: new Date(earthquake.date),
            title: earthquake.title || 'Bilinmeyen Konum',
            mag: parseFloat(earthquake.mag) || 0,
            depth: parseFloat(earthquake.depth) || 0,
            lat: parseFloat(earthquake.lat) || 0,
            lng: parseFloat(earthquake.lng) || 0
        };
        
        // Deprem zaten listede var mı kontrol et
        const exists = allEarthquakes.some(eq => eq.id === newEarthquake.id);
        
        if (!exists) {
            // Yeni depremi listeye ekle
            allEarthquakes.unshift(newEarthquake);
            
            // UI'ı güncelle
            applyFilters();
            
            // Bildirim göster
            if (newEarthquake.mag >= 4.0) {
                showEarthquakeNotification(newEarthquake);
            }
            
            // Gerçek zamanlı güncelleme bildirimi
            showToast(`Yeni deprem verisi alındı: ${newEarthquake.mag.toFixed(1)} - ${newEarthquake.title}`, 'primary');
            
            // Mesaj göster
            const realtimeMessage = document.getElementById('realtimeMessage');
            if (realtimeMessage) {
                realtimeMessage.textContent = 'Yeni deprem verisi alındı!';
                setTimeout(() => {
                    realtimeMessage.textContent = 'Gerçek zamanlı güncellemeler aktif';
                }, 5000);
            }
        }
    }
    
    // Bölgesel deprem tavsiyelerini ayarla
    function setupRegionalAdvice() {
        const regionSelect = document.getElementById('regionSelect');
        if (!regionSelect) return;
        
        // Bölge seçimi değiştiğinde
        regionSelect.addEventListener('change', updateRegionalAdvice);
        
        // İlk yükleme için 
        updateRegionalAdvice();
        
        function updateRegionalAdvice() {
            const selectedRegion = regionSelect.value;
            const adviceContainer = document.getElementById('regionalAdvice');
            if (!adviceContainer) return;
            
            let adviceHTML = '';
            
            switch (selectedRegion) {
                case 'marmara':
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>Marmara Bölgesi İçin Özel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Kuzey Anadolu Fay Hattının aktif olduğu bölgede bulunuyorsunuz</li>
                                <li>Deprem çantanızı hazır bulundurun</li>
                                <li>Aile toplanma planı oluşturun</li>
                                <li>AFAD'ın toplanma alanlarını öğrenin</li>
                            </ul>
                        </div>
                    `;
                    break;
                    
                case 'ege':
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>Ege Bölgesi İçin Özel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Bölgenizde aktif fay hatları bulunmaktadır</li>
                                <li>Tsunami riski olan kıyı bölgelerinde iseniz tahliye planı yapın</li>
                                <li>Yüksek binalardan hızla tahliye planı oluşturun</li>
                                <li>Yerel yönetimlerin belirlediği toplanma alanlarını öğrenin</li>
                            </ul>
                        </div>
                    `;
                    break;
                    
                case 'akdeniz':
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>Akdeniz Bölgesi İçin Özel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Doğu Anadolu Fay Hattı bölgenizi etkilemektedir</li>
                                <li>Kıyı bölgelerinde tsunami riskine karşı hazırlıklı olun</li>
                                <li>Tatil bölgelerindeki yüksek yapılarda kaçış planı yapın</li>
                                <li>Deprem sonrası yangın riskine karşı önlem alın</li>
                            </ul>
                        </div>
                    `;
                    break;
                    
                case 'karadeniz':
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>Karadeniz Bölgesi İçin Özel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Kuzey Anadolu Fay Hattı bölgenizi etkilemektedir</li>
                                <li>Heyelan riski yüksek bölgelerde ek önlemler alın</li>
                                <li>Dik yamaçlardan uzak durun</li>
                                <li>İletişim kanallarını açık tutun, bölgesel uyarıları takip edin</li>
                            </ul>
                        </div>
                    `;
                    break;
                    
                case 'ic_anadolu':
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>İç Anadolu Bölgesi İçin Özel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Bölgenizde çeşitli fay hatları bulunmaktadır</li>
                                <li>Eski yapılardan uzak durun, güçlendirme yapılmamış binalar risk taşır</li>
                                <li>Kırsal alanlarda iletişim kesintilerine hazırlıklı olun</li>
                                <li>Depremden sonra kış şartlarında hayatta kalma hazırlığı yapın</li>
                            </ul>
                        </div>
                    `;
                    break;
                    
                case 'dogu_anadolu':
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>Doğu Anadolu Bölgesi İçin Özel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Bölgeniz Türkiye'nin en aktif deprem bölgelerinden biridir</li>
                                <li>Kış şartlarında deprem sonrası için ısınma malzemeleri bulundurun</li>
                                <li>Uzak yerleşim yerlerinde yaşıyorsanız en az 72 saatlik acil durum kiti hazırlayın</li>
                                <li>Binalarınızın depreme dayanıklılığını kontrol ettirin</li>
                            </ul>
                        </div>
                    `;
                    break;
                    
                case 'guneydogu_anadolu':
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>Güneydoğu Anadolu Bölgesi İçin Özel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Doğu Anadolu Fay Hattı bölgenizden geçmektedir</li>
                                <li>6 Şubat 2023 depreminden etkilenen bölgelerde artçı riskleri devam etmektedir</li>
                                <li>Hasar görmüş binalara kesinlikle girmeyin</li>
                                <li>Su, gıda ve temel ihtiyaçları içeren bir acil durum kiti hazırlayın</li>
                            </ul>
                        </div>
                    `;
                    break;
                    
                default:
                    adviceHTML = `
                        <div class="alert alert-info">
                            <p><strong>Genel Tavsiyeler:</strong></p>
                            <ul class="mb-0">
                                <li>Acil durum çantası hazırlayın</li>
                                <li>Aile afet planı oluşturun</li>
                                <li>Binalarınızın depreme dayanıklılığını kontrol ettirin</li>
                                <li>Yerel yönetimlerin belirlediği toplanma alanlarını öğrenin</li>
                            </ul>
                        </div>
                    `;
            }
            
            adviceContainer.innerHTML = adviceHTML;
        }
    }
    
    // Sayfa yüklendiğinde çalıştırılacak kodlar
    function initializePage() {
        try {
            console.log('Sayfa başlatılıyor...');
            
            // UI elemanlarının başlangıç değerlerini ayarla
            const magnitudeFilterElement = document.getElementById('magnitudeFilter');
            const locationFilterElement = document.getElementById('locationFilter');
            
            if (magnitudeFilterElement) magnitudeFilterElement.value = userPreferences.minMagnitude;
            if (locationFilterElement) locationFilterElement.value = userPreferences.locationFilter;
            
            updateNotificationToggle();
            
            // Haritayı başlat
            initializeMap();
            
            // İlk verileri getir
            fetchEarthquakeData();
            
            // Periyodik güncelleme (5 dakika)
            setInterval(() => fetchEarthquakeData(), REFRESH_INTERVAL);
            
            // Olay dinleyicileri
            const attachEventListener = (id, event, handler) => {
                const element = document.getElementById(id);
                if (element) element.addEventListener(event, handler);
            };
            
            attachEventListener('applyFilterBtn', 'click', applyFilters);
            
            attachEventListener('clearFilterBtn', 'click', () => {
                const magnitudeFilter = document.getElementById('magnitudeFilter');
                const locationFilter = document.getElementById('locationFilter');
                
                if (magnitudeFilter) magnitudeFilter.value = DEFAULT_MIN_MAGNITUDE;
                if (locationFilter) locationFilter.value = '';
                
                applyFilters();
            });
            
            attachEventListener('loadMoreBtn', 'click', loadMoreEarthquakes);
            
            attachEventListener('refreshMapBtn', 'click', () => {
                fetchEarthquakeData(true);
            });
            
            attachEventListener('notificationToggle', 'click', requestNotificationPermission);
            
            // Enter tuşu ile filtreleme
            if (locationFilterElement) {
                locationFilterElement.addEventListener('keyup', function(event) {
                    if (event.key === 'Enter') {
                        applyFilters();
                    }
                });
            }
            
            // Gerçek zamanlı bağlantıyı kur
            initializeRealTimeConnection();
            
            // Bölgesel deprem tavsiyelerini ayarla
            setupRegionalAdvice();
            
            console.log('Sayfa başlatma tamamlandı');
        } catch (error) {
            console.error('Sayfa başlatma hatası:', error);
            showErrorMessage('Sayfa başlatılırken bir hata oluştu: ' + error.message);
        }
    }
    
    // Sayfayı başlat
    initializePage();
});