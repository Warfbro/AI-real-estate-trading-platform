
const app = getApp()

Page({
  data: {
    showAnim: true,
    statusBarHeight: 20,
    navBarHeight: 44,
    totalNavHeight: 64,
    capWidth: 90, // 定义胶囊区域宽度，实现完美居中对抗
    canBack: true,
    showMorePanel: false,
    scrollTo: '',
    
    drawerHeight: 500,
    offset: -500, 
    isDragging: false,
    drawerState: 'closed',
    dragDir: ''
  },

  onLoad(options) {
    let sysInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    let navH = 44;
    let diff = 0;
    let capW = 90;
    
    if (wx.getMenuButtonBoundingClientRect) {
      const rect = wx.getMenuButtonBoundingClientRect();
      navH = rect.height;
      diff = rect.top - sysInfo.statusBarHeight;
      capW = sysInfo.windowWidth - rect.left; // 屏幕右侧被原生胶囊占用的宽度
    }
    
    let navBarHeight = navH + diff * 2;
    let totalNavHeight = sysInfo.statusBarHeight + navBarHeight;
    const maxVP = sysInfo.windowHeight - totalNavHeight;
    const drawerHeight = maxVP * 0.70;
    
    this.setData({
      statusBarHeight: sysInfo.statusBarHeight,
      navBarHeight: navBarHeight,
      totalNavHeight: totalNavHeight,
      capWidth: capW,
      canBack: getCurrentPages().length > 1,
      drawerHeight: drawerHeight,
      offset: -drawerHeight
    });

    setTimeout(() => {
      this.setData({ showAnim: false });
    }, 850);
  },

  handleBack() {
    if (this.data.canBack) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/home/index' });
    }
  },

  onTouchStart(e) {
    if (!e.touches.length) return;
    this.startY = e.touches[0].clientY;
    this.startOffset = this.data.offset;
    this.setData({ 
      isDragging: true,
      dragDir: this.data.drawerState === 'closed' ? 'down' : 'up'
    });
  },

  onTouchMove(e) {
    if (!e.touches.length) return;
    let currentY = e.touches[0].clientY;
    let deltaY = currentY - this.startY;
    let newOffset = this.startOffset + deltaY;
    let DH = this.data.drawerHeight;

    if (newOffset > 0) newOffset = newOffset * 0.2; 
    else if (newOffset < -DH) {
      let overflow = -DH - newOffset; 
      newOffset = -DH - (overflow * 0.2); 
    }

    let dir = '';
    if (deltaY > 5) dir = 'down';
    else if (deltaY < -5) dir = 'up';

    if (dir && dir !== this.data.dragDir) {
       this.setData({ dragDir: dir, offset: newOffset });
    } else {
       this.setData({ offset: newOffset });
    }
  },

  onTouchEnd(e) {
    if (!e.changedTouches.length) return;
    let currentY = e.changedTouches[0].clientY;
    let deltaY = currentY - this.startY;
    
    let DH = this.data.drawerHeight;
    let finalOffset = this.data.offset;
    let newState = this.data.drawerState;
    
    if (this.data.drawerState === 'closed') {
       if (deltaY > 60) { finalOffset = 0; newState = 'open'; } 
       else { finalOffset = -DH; newState = 'closed'; }
    } else {
       if (deltaY < -60) { finalOffset = -DH; newState = 'closed'; } 
       else { finalOffset = 0; newState = 'open'; }
    }

    this.setData({
      isDragging: false,
      offset: finalOffset,
      drawerState: newState,
      dragDir: ''
    });
  },

  handleNewChat() {
    wx.showToast({ title: '已开启新对话', icon: 'none' });
    this.setData({ offset: -this.data.drawerHeight, drawerState: 'closed' });
  },

  toggleMorePanel() { this.setData({ showMorePanel: !this.data.showMorePanel }); },
  onInput(e) {},
  handleImportImage() { wx.showToast({ title: '准备导入图片...', icon: 'none' }); },
  handleViewFavorites() { wx.showToast({ title: '正在打开收藏...', icon: 'none' }); }
})
