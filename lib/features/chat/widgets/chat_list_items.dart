import '../../../core/database/database.dart';

abstract class ChatListItem {}

class DateDividerItem extends ChatListItem {
  final DateTime date;
  DateDividerItem(this.date);
}

class MessageItem extends ChatListItem {
  final Message message;
  MessageItem(this.message);
}

/// 加载更多指示器 — 长对话分页懒加载
class LoadMoreItem extends ChatListItem {}
