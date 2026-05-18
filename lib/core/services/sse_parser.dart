import 'dart:convert';

class SseParser {
  String _buffer = '';

  List<Map<String, dynamic>> parseChunk(List<int> chunk) {
    final decoded = utf8.decoder.convert(chunk);
    _buffer += decoded;
    final results = <Map<String, dynamic>>[];
    final parts = _buffer.split('\n\n');
    _buffer = parts.removeLast();

    for (final part in parts) {
      for (final line in part.split('\n')) {
        final trimmed = line.trim();
        if (trimmed.isEmpty || trimmed == 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          final json = jsonDecode(trimmed.substring(6));
          results.add(json as Map<String, dynamic>);
        } catch (_) {}
      }
    }
    return results;
  }

  List<Map<String, dynamic>> flush() {
    if (_buffer.trim().isEmpty) return [];
    final results = <Map<String, dynamic>>[];
    for (final line in _buffer.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.isEmpty ||
          trimmed == 'data: [DONE]' ||
          !trimmed.startsWith('data: ')) {
        continue;
      }
      try {
        final json = jsonDecode(trimmed.substring(6));
        results.add(json as Map<String, dynamic>);
      } catch (_) {}
    }
    _buffer = '';
    return results;
  }

  void reset() {
    _buffer = '';
  }
}
