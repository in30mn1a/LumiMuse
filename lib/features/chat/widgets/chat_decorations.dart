import 'package:flutter/material.dart';
import '../../../core/database/database.dart';
import '../../../theme/app_theme.dart';
import '../../../theme/app_widgets.dart';

class CharacterAvatar extends StatelessWidget {
  final Character character;
  final double size;

  const CharacterAvatar({super.key, required this.character, this.size = 40});

  @override
  Widget build(BuildContext context) {
    final hasAvatar =
        character.avatarUrl != null && character.avatarUrl!.isNotEmpty;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: hasAvatar
            ? null
            : const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [AppTheme.accent, AppTheme.accentDark],
              ),
        borderRadius: BorderRadius.circular(14),
      ),
      clipBehavior: Clip.antiAlias,
      child: hasAvatar
          ? LumiNetworkImage(
              url: character.avatarUrl!,
              fit: BoxFit.cover,
            )
          : _initial(),
    );
  }

  Widget _initial() {
    return Center(
      child: Text(
        character.name.isNotEmpty ? character.name[0] : '?',
        style: const TextStyle(
          color: Colors.white,
          fontSize: 16,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class HomeGlow extends StatefulWidget {
  const HomeGlow({super.key});

  @override
  State<HomeGlow> createState() => _HomeGlowState();
}

class _HomeGlowState extends State<HomeGlow>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 4),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = _controller.value;
        final scale = 1.0 + 0.12 * t;
        final opacity = 0.6 + 0.4 * t;
        return Transform.scale(
          scale: scale,
          child: Container(
            width: 320,
            height: 320,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                colors: [
                  AppTheme.accent.withValues(alpha: 0.18 * opacity),
                  AppTheme.accent.withValues(alpha: 0.0),
                ],
                stops: const [0.0, 0.7],
              ),
            ),
          ),
        );
      },
    );
  }
}
