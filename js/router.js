/* router.js — minimaler Hash-Router (funktioniert auch unter file://). */
(function () {
  'use strict';
  window.App = window.App || {};

  var routes = [];
  var notFound = null;
  var currentCleanup = null;

  function compile(pattern) {
    var parts = pattern.split('/').filter(Boolean);
    return function (segments) {
      if (parts.length !== segments.length) return null;
      var params = {};
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].charAt(0) === ':') params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
        else if (parts[i] !== segments[i]) return null;
      }
      return params;
    };
  }

  var Router = {
    add: function (pattern, handler) {
      routes.push({ match: compile(pattern), handler: handler });
      return this;
    },
    setNotFound: function (handler) { notFound = handler; return this; },

    go: function (path) { window.location.hash = '#' + path; },

    current: function () {
      var h = window.location.hash.replace(/^#/, '') || '/';
      return h;
    },

    render: function () {
      // Aufräumen der vorherigen View (Intervalle, Animationen).
      if (typeof currentCleanup === 'function') {
        try { currentCleanup(); } catch (e) {}
        currentCleanup = null;
      }
      var path = this.current();
      var segments = path.split('?')[0].split('/').filter(Boolean);
      for (var i = 0; i < routes.length; i++) {
        var params = routes[i].match(segments);
        if (params) {
          currentCleanup = routes[i].handler(params) || null;
          window.scrollTo(0, 0);
          return;
        }
      }
      if (notFound) currentCleanup = notFound() || null;
    },

    start: function () {
      var self = this;
      window.addEventListener('hashchange', function () { self.render(); });
      if (!window.location.hash) window.location.hash = '#/';
      else this.render();
    }
  };

  App.Router = Router;
})();
