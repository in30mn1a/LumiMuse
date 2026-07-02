// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'database.dart';

// ignore_for_file: type=lint
class $CharactersTable extends Characters
    with TableInfo<$CharactersTable, Character> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CharactersTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _avatarUrlMeta = const VerificationMeta(
    'avatarUrl',
  );
  @override
  late final GeneratedColumn<String> avatarUrl = GeneratedColumn<String>(
    'avatar_url',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _personalityMeta = const VerificationMeta(
    'personality',
  );
  @override
  late final GeneratedColumn<String> personality = GeneratedColumn<String>(
    'personality',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _scenarioMeta = const VerificationMeta(
    'scenario',
  );
  @override
  late final GeneratedColumn<String> scenario = GeneratedColumn<String>(
    'scenario',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _greetingMeta = const VerificationMeta(
    'greeting',
  );
  @override
  late final GeneratedColumn<String> greeting = GeneratedColumn<String>(
    'greeting',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _exampleDialogueMeta = const VerificationMeta(
    'exampleDialogue',
  );
  @override
  late final GeneratedColumn<String> exampleDialogue = GeneratedColumn<String>(
    'example_dialogue',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _systemPromptMeta = const VerificationMeta(
    'systemPrompt',
  );
  @override
  late final GeneratedColumn<String> systemPrompt = GeneratedColumn<String>(
    'system_prompt',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _basicInfoMeta = const VerificationMeta(
    'basicInfo',
  );
  @override
  late final GeneratedColumn<String> basicInfo = GeneratedColumn<String>(
    'basic_info',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _otherInfoMeta = const VerificationMeta(
    'otherInfo',
  );
  @override
  late final GeneratedColumn<String> otherInfo = GeneratedColumn<String>(
    'other_info',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _imageTagsMeta = const VerificationMeta(
    'imageTags',
  );
  @override
  late final GeneratedColumn<String> imageTags = GeneratedColumn<String>(
    'image_tags',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _userImageTagsMeta = const VerificationMeta(
    'userImageTags',
  );
  @override
  late final GeneratedColumn<String> userImageTags = GeneratedColumn<String>(
    'user_image_tags',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _sortOrderMeta = const VerificationMeta(
    'sortOrder',
  );
  @override
  late final GeneratedColumn<int> sortOrder = GeneratedColumn<int>(
    'sort_order',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    name,
    avatarUrl,
    personality,
    scenario,
    greeting,
    exampleDialogue,
    systemPrompt,
    basicInfo,
    otherInfo,
    imageTags,
    userImageTags,
    sortOrder,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'characters';
  @override
  VerificationContext validateIntegrity(
    Insertable<Character> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    }
    if (data.containsKey('avatar_url')) {
      context.handle(
        _avatarUrlMeta,
        avatarUrl.isAcceptableOrUnknown(data['avatar_url']!, _avatarUrlMeta),
      );
    }
    if (data.containsKey('personality')) {
      context.handle(
        _personalityMeta,
        personality.isAcceptableOrUnknown(
          data['personality']!,
          _personalityMeta,
        ),
      );
    }
    if (data.containsKey('scenario')) {
      context.handle(
        _scenarioMeta,
        scenario.isAcceptableOrUnknown(data['scenario']!, _scenarioMeta),
      );
    }
    if (data.containsKey('greeting')) {
      context.handle(
        _greetingMeta,
        greeting.isAcceptableOrUnknown(data['greeting']!, _greetingMeta),
      );
    }
    if (data.containsKey('example_dialogue')) {
      context.handle(
        _exampleDialogueMeta,
        exampleDialogue.isAcceptableOrUnknown(
          data['example_dialogue']!,
          _exampleDialogueMeta,
        ),
      );
    }
    if (data.containsKey('system_prompt')) {
      context.handle(
        _systemPromptMeta,
        systemPrompt.isAcceptableOrUnknown(
          data['system_prompt']!,
          _systemPromptMeta,
        ),
      );
    }
    if (data.containsKey('basic_info')) {
      context.handle(
        _basicInfoMeta,
        basicInfo.isAcceptableOrUnknown(data['basic_info']!, _basicInfoMeta),
      );
    }
    if (data.containsKey('other_info')) {
      context.handle(
        _otherInfoMeta,
        otherInfo.isAcceptableOrUnknown(data['other_info']!, _otherInfoMeta),
      );
    }
    if (data.containsKey('image_tags')) {
      context.handle(
        _imageTagsMeta,
        imageTags.isAcceptableOrUnknown(data['image_tags']!, _imageTagsMeta),
      );
    }
    if (data.containsKey('user_image_tags')) {
      context.handle(
        _userImageTagsMeta,
        userImageTags.isAcceptableOrUnknown(
          data['user_image_tags']!,
          _userImageTagsMeta,
        ),
      );
    }
    if (data.containsKey('sort_order')) {
      context.handle(
        _sortOrderMeta,
        sortOrder.isAcceptableOrUnknown(data['sort_order']!, _sortOrderMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Character map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Character(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      avatarUrl: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}avatar_url'],
      ),
      personality: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}personality'],
      )!,
      scenario: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}scenario'],
      )!,
      greeting: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}greeting'],
      )!,
      exampleDialogue: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}example_dialogue'],
      )!,
      systemPrompt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}system_prompt'],
      )!,
      basicInfo: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}basic_info'],
      )!,
      otherInfo: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}other_info'],
      )!,
      imageTags: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_tags'],
      )!,
      userImageTags: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}user_image_tags'],
      )!,
      sortOrder: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}sort_order'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $CharactersTable createAlias(String alias) {
    return $CharactersTable(attachedDatabase, alias);
  }
}

class Character extends DataClass implements Insertable<Character> {
  final String id;
  final String name;
  final String? avatarUrl;
  final String personality;
  final String scenario;
  final String greeting;
  final String exampleDialogue;
  final String systemPrompt;
  final String basicInfo;
  final String otherInfo;
  final String imageTags;
  final String userImageTags;
  final int sortOrder;
  final DateTime createdAt;
  final DateTime updatedAt;
  const Character({
    required this.id,
    required this.name,
    this.avatarUrl,
    required this.personality,
    required this.scenario,
    required this.greeting,
    required this.exampleDialogue,
    required this.systemPrompt,
    required this.basicInfo,
    required this.otherInfo,
    required this.imageTags,
    required this.userImageTags,
    required this.sortOrder,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['name'] = Variable<String>(name);
    if (!nullToAbsent || avatarUrl != null) {
      map['avatar_url'] = Variable<String>(avatarUrl);
    }
    map['personality'] = Variable<String>(personality);
    map['scenario'] = Variable<String>(scenario);
    map['greeting'] = Variable<String>(greeting);
    map['example_dialogue'] = Variable<String>(exampleDialogue);
    map['system_prompt'] = Variable<String>(systemPrompt);
    map['basic_info'] = Variable<String>(basicInfo);
    map['other_info'] = Variable<String>(otherInfo);
    map['image_tags'] = Variable<String>(imageTags);
    map['user_image_tags'] = Variable<String>(userImageTags);
    map['sort_order'] = Variable<int>(sortOrder);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  CharactersCompanion toCompanion(bool nullToAbsent) {
    return CharactersCompanion(
      id: Value(id),
      name: Value(name),
      avatarUrl: avatarUrl == null && nullToAbsent
          ? const Value.absent()
          : Value(avatarUrl),
      personality: Value(personality),
      scenario: Value(scenario),
      greeting: Value(greeting),
      exampleDialogue: Value(exampleDialogue),
      systemPrompt: Value(systemPrompt),
      basicInfo: Value(basicInfo),
      otherInfo: Value(otherInfo),
      imageTags: Value(imageTags),
      userImageTags: Value(userImageTags),
      sortOrder: Value(sortOrder),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory Character.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Character(
      id: serializer.fromJson<String>(json['id']),
      name: serializer.fromJson<String>(json['name']),
      avatarUrl: serializer.fromJson<String?>(json['avatarUrl']),
      personality: serializer.fromJson<String>(json['personality']),
      scenario: serializer.fromJson<String>(json['scenario']),
      greeting: serializer.fromJson<String>(json['greeting']),
      exampleDialogue: serializer.fromJson<String>(json['exampleDialogue']),
      systemPrompt: serializer.fromJson<String>(json['systemPrompt']),
      basicInfo: serializer.fromJson<String>(json['basicInfo']),
      otherInfo: serializer.fromJson<String>(json['otherInfo']),
      imageTags: serializer.fromJson<String>(json['imageTags']),
      userImageTags: serializer.fromJson<String>(json['userImageTags']),
      sortOrder: serializer.fromJson<int>(json['sortOrder']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'name': serializer.toJson<String>(name),
      'avatarUrl': serializer.toJson<String?>(avatarUrl),
      'personality': serializer.toJson<String>(personality),
      'scenario': serializer.toJson<String>(scenario),
      'greeting': serializer.toJson<String>(greeting),
      'exampleDialogue': serializer.toJson<String>(exampleDialogue),
      'systemPrompt': serializer.toJson<String>(systemPrompt),
      'basicInfo': serializer.toJson<String>(basicInfo),
      'otherInfo': serializer.toJson<String>(otherInfo),
      'imageTags': serializer.toJson<String>(imageTags),
      'userImageTags': serializer.toJson<String>(userImageTags),
      'sortOrder': serializer.toJson<int>(sortOrder),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  Character copyWith({
    String? id,
    String? name,
    Value<String?> avatarUrl = const Value.absent(),
    String? personality,
    String? scenario,
    String? greeting,
    String? exampleDialogue,
    String? systemPrompt,
    String? basicInfo,
    String? otherInfo,
    String? imageTags,
    String? userImageTags,
    int? sortOrder,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => Character(
    id: id ?? this.id,
    name: name ?? this.name,
    avatarUrl: avatarUrl.present ? avatarUrl.value : this.avatarUrl,
    personality: personality ?? this.personality,
    scenario: scenario ?? this.scenario,
    greeting: greeting ?? this.greeting,
    exampleDialogue: exampleDialogue ?? this.exampleDialogue,
    systemPrompt: systemPrompt ?? this.systemPrompt,
    basicInfo: basicInfo ?? this.basicInfo,
    otherInfo: otherInfo ?? this.otherInfo,
    imageTags: imageTags ?? this.imageTags,
    userImageTags: userImageTags ?? this.userImageTags,
    sortOrder: sortOrder ?? this.sortOrder,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  Character copyWithCompanion(CharactersCompanion data) {
    return Character(
      id: data.id.present ? data.id.value : this.id,
      name: data.name.present ? data.name.value : this.name,
      avatarUrl: data.avatarUrl.present ? data.avatarUrl.value : this.avatarUrl,
      personality: data.personality.present
          ? data.personality.value
          : this.personality,
      scenario: data.scenario.present ? data.scenario.value : this.scenario,
      greeting: data.greeting.present ? data.greeting.value : this.greeting,
      exampleDialogue: data.exampleDialogue.present
          ? data.exampleDialogue.value
          : this.exampleDialogue,
      systemPrompt: data.systemPrompt.present
          ? data.systemPrompt.value
          : this.systemPrompt,
      basicInfo: data.basicInfo.present ? data.basicInfo.value : this.basicInfo,
      otherInfo: data.otherInfo.present ? data.otherInfo.value : this.otherInfo,
      imageTags: data.imageTags.present ? data.imageTags.value : this.imageTags,
      userImageTags: data.userImageTags.present
          ? data.userImageTags.value
          : this.userImageTags,
      sortOrder: data.sortOrder.present ? data.sortOrder.value : this.sortOrder,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Character(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('avatarUrl: $avatarUrl, ')
          ..write('personality: $personality, ')
          ..write('scenario: $scenario, ')
          ..write('greeting: $greeting, ')
          ..write('exampleDialogue: $exampleDialogue, ')
          ..write('systemPrompt: $systemPrompt, ')
          ..write('basicInfo: $basicInfo, ')
          ..write('otherInfo: $otherInfo, ')
          ..write('imageTags: $imageTags, ')
          ..write('userImageTags: $userImageTags, ')
          ..write('sortOrder: $sortOrder, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    name,
    avatarUrl,
    personality,
    scenario,
    greeting,
    exampleDialogue,
    systemPrompt,
    basicInfo,
    otherInfo,
    imageTags,
    userImageTags,
    sortOrder,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Character &&
          other.id == this.id &&
          other.name == this.name &&
          other.avatarUrl == this.avatarUrl &&
          other.personality == this.personality &&
          other.scenario == this.scenario &&
          other.greeting == this.greeting &&
          other.exampleDialogue == this.exampleDialogue &&
          other.systemPrompt == this.systemPrompt &&
          other.basicInfo == this.basicInfo &&
          other.otherInfo == this.otherInfo &&
          other.imageTags == this.imageTags &&
          other.userImageTags == this.userImageTags &&
          other.sortOrder == this.sortOrder &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class CharactersCompanion extends UpdateCompanion<Character> {
  final Value<String> id;
  final Value<String> name;
  final Value<String?> avatarUrl;
  final Value<String> personality;
  final Value<String> scenario;
  final Value<String> greeting;
  final Value<String> exampleDialogue;
  final Value<String> systemPrompt;
  final Value<String> basicInfo;
  final Value<String> otherInfo;
  final Value<String> imageTags;
  final Value<String> userImageTags;
  final Value<int> sortOrder;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const CharactersCompanion({
    this.id = const Value.absent(),
    this.name = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.personality = const Value.absent(),
    this.scenario = const Value.absent(),
    this.greeting = const Value.absent(),
    this.exampleDialogue = const Value.absent(),
    this.systemPrompt = const Value.absent(),
    this.basicInfo = const Value.absent(),
    this.otherInfo = const Value.absent(),
    this.imageTags = const Value.absent(),
    this.userImageTags = const Value.absent(),
    this.sortOrder = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CharactersCompanion.insert({
    required String id,
    this.name = const Value.absent(),
    this.avatarUrl = const Value.absent(),
    this.personality = const Value.absent(),
    this.scenario = const Value.absent(),
    this.greeting = const Value.absent(),
    this.exampleDialogue = const Value.absent(),
    this.systemPrompt = const Value.absent(),
    this.basicInfo = const Value.absent(),
    this.otherInfo = const Value.absent(),
    this.imageTags = const Value.absent(),
    this.userImageTags = const Value.absent(),
    this.sortOrder = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id);
  static Insertable<Character> custom({
    Expression<String>? id,
    Expression<String>? name,
    Expression<String>? avatarUrl,
    Expression<String>? personality,
    Expression<String>? scenario,
    Expression<String>? greeting,
    Expression<String>? exampleDialogue,
    Expression<String>? systemPrompt,
    Expression<String>? basicInfo,
    Expression<String>? otherInfo,
    Expression<String>? imageTags,
    Expression<String>? userImageTags,
    Expression<int>? sortOrder,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (name != null) 'name': name,
      if (avatarUrl != null) 'avatar_url': avatarUrl,
      if (personality != null) 'personality': personality,
      if (scenario != null) 'scenario': scenario,
      if (greeting != null) 'greeting': greeting,
      if (exampleDialogue != null) 'example_dialogue': exampleDialogue,
      if (systemPrompt != null) 'system_prompt': systemPrompt,
      if (basicInfo != null) 'basic_info': basicInfo,
      if (otherInfo != null) 'other_info': otherInfo,
      if (imageTags != null) 'image_tags': imageTags,
      if (userImageTags != null) 'user_image_tags': userImageTags,
      if (sortOrder != null) 'sort_order': sortOrder,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CharactersCompanion copyWith({
    Value<String>? id,
    Value<String>? name,
    Value<String?>? avatarUrl,
    Value<String>? personality,
    Value<String>? scenario,
    Value<String>? greeting,
    Value<String>? exampleDialogue,
    Value<String>? systemPrompt,
    Value<String>? basicInfo,
    Value<String>? otherInfo,
    Value<String>? imageTags,
    Value<String>? userImageTags,
    Value<int>? sortOrder,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return CharactersCompanion(
      id: id ?? this.id,
      name: name ?? this.name,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      personality: personality ?? this.personality,
      scenario: scenario ?? this.scenario,
      greeting: greeting ?? this.greeting,
      exampleDialogue: exampleDialogue ?? this.exampleDialogue,
      systemPrompt: systemPrompt ?? this.systemPrompt,
      basicInfo: basicInfo ?? this.basicInfo,
      otherInfo: otherInfo ?? this.otherInfo,
      imageTags: imageTags ?? this.imageTags,
      userImageTags: userImageTags ?? this.userImageTags,
      sortOrder: sortOrder ?? this.sortOrder,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (avatarUrl.present) {
      map['avatar_url'] = Variable<String>(avatarUrl.value);
    }
    if (personality.present) {
      map['personality'] = Variable<String>(personality.value);
    }
    if (scenario.present) {
      map['scenario'] = Variable<String>(scenario.value);
    }
    if (greeting.present) {
      map['greeting'] = Variable<String>(greeting.value);
    }
    if (exampleDialogue.present) {
      map['example_dialogue'] = Variable<String>(exampleDialogue.value);
    }
    if (systemPrompt.present) {
      map['system_prompt'] = Variable<String>(systemPrompt.value);
    }
    if (basicInfo.present) {
      map['basic_info'] = Variable<String>(basicInfo.value);
    }
    if (otherInfo.present) {
      map['other_info'] = Variable<String>(otherInfo.value);
    }
    if (imageTags.present) {
      map['image_tags'] = Variable<String>(imageTags.value);
    }
    if (userImageTags.present) {
      map['user_image_tags'] = Variable<String>(userImageTags.value);
    }
    if (sortOrder.present) {
      map['sort_order'] = Variable<int>(sortOrder.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CharactersCompanion(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('avatarUrl: $avatarUrl, ')
          ..write('personality: $personality, ')
          ..write('scenario: $scenario, ')
          ..write('greeting: $greeting, ')
          ..write('exampleDialogue: $exampleDialogue, ')
          ..write('systemPrompt: $systemPrompt, ')
          ..write('basicInfo: $basicInfo, ')
          ..write('otherInfo: $otherInfo, ')
          ..write('imageTags: $imageTags, ')
          ..write('userImageTags: $userImageTags, ')
          ..write('sortOrder: $sortOrder, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ConversationsTable extends Conversations
    with TableInfo<$ConversationsTable, Conversation> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ConversationsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _titleMeta = const VerificationMeta('title');
  @override
  late final GeneratedColumn<String> title = GeneratedColumn<String>(
    'title',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _ignoreMemoryMeta = const VerificationMeta(
    'ignoreMemory',
  );
  @override
  late final GeneratedColumn<int> ignoreMemory = GeneratedColumn<int>(
    'ignore_memory',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    characterId,
    title,
    ignoreMemory,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'conversations';
  @override
  VerificationContext validateIntegrity(
    Insertable<Conversation> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('title')) {
      context.handle(
        _titleMeta,
        title.isAcceptableOrUnknown(data['title']!, _titleMeta),
      );
    }
    if (data.containsKey('ignore_memory')) {
      context.handle(
        _ignoreMemoryMeta,
        ignoreMemory.isAcceptableOrUnknown(
          data['ignore_memory']!,
          _ignoreMemoryMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Conversation map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Conversation(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      title: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}title'],
      )!,
      ignoreMemory: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}ignore_memory'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $ConversationsTable createAlias(String alias) {
    return $ConversationsTable(attachedDatabase, alias);
  }
}

class Conversation extends DataClass implements Insertable<Conversation> {
  final String id;
  final String characterId;
  final String title;
  final int ignoreMemory;
  final DateTime createdAt;
  final DateTime updatedAt;
  const Conversation({
    required this.id,
    required this.characterId,
    required this.title,
    required this.ignoreMemory,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['character_id'] = Variable<String>(characterId);
    map['title'] = Variable<String>(title);
    map['ignore_memory'] = Variable<int>(ignoreMemory);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  ConversationsCompanion toCompanion(bool nullToAbsent) {
    return ConversationsCompanion(
      id: Value(id),
      characterId: Value(characterId),
      title: Value(title),
      ignoreMemory: Value(ignoreMemory),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory Conversation.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Conversation(
      id: serializer.fromJson<String>(json['id']),
      characterId: serializer.fromJson<String>(json['characterId']),
      title: serializer.fromJson<String>(json['title']),
      ignoreMemory: serializer.fromJson<int>(json['ignoreMemory']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'characterId': serializer.toJson<String>(characterId),
      'title': serializer.toJson<String>(title),
      'ignoreMemory': serializer.toJson<int>(ignoreMemory),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  Conversation copyWith({
    String? id,
    String? characterId,
    String? title,
    int? ignoreMemory,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => Conversation(
    id: id ?? this.id,
    characterId: characterId ?? this.characterId,
    title: title ?? this.title,
    ignoreMemory: ignoreMemory ?? this.ignoreMemory,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  Conversation copyWithCompanion(ConversationsCompanion data) {
    return Conversation(
      id: data.id.present ? data.id.value : this.id,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      title: data.title.present ? data.title.value : this.title,
      ignoreMemory: data.ignoreMemory.present
          ? data.ignoreMemory.value
          : this.ignoreMemory,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Conversation(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('title: $title, ')
          ..write('ignoreMemory: $ignoreMemory, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(id, characterId, title, ignoreMemory, createdAt, updatedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Conversation &&
          other.id == this.id &&
          other.characterId == this.characterId &&
          other.title == this.title &&
          other.ignoreMemory == this.ignoreMemory &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class ConversationsCompanion extends UpdateCompanion<Conversation> {
  final Value<String> id;
  final Value<String> characterId;
  final Value<String> title;
  final Value<int> ignoreMemory;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const ConversationsCompanion({
    this.id = const Value.absent(),
    this.characterId = const Value.absent(),
    this.title = const Value.absent(),
    this.ignoreMemory = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ConversationsCompanion.insert({
    required String id,
    required String characterId,
    this.title = const Value.absent(),
    this.ignoreMemory = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       characterId = Value(characterId);
  static Insertable<Conversation> custom({
    Expression<String>? id,
    Expression<String>? characterId,
    Expression<String>? title,
    Expression<int>? ignoreMemory,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (characterId != null) 'character_id': characterId,
      if (title != null) 'title': title,
      if (ignoreMemory != null) 'ignore_memory': ignoreMemory,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ConversationsCompanion copyWith({
    Value<String>? id,
    Value<String>? characterId,
    Value<String>? title,
    Value<int>? ignoreMemory,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return ConversationsCompanion(
      id: id ?? this.id,
      characterId: characterId ?? this.characterId,
      title: title ?? this.title,
      ignoreMemory: ignoreMemory ?? this.ignoreMemory,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (title.present) {
      map['title'] = Variable<String>(title.value);
    }
    if (ignoreMemory.present) {
      map['ignore_memory'] = Variable<int>(ignoreMemory.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ConversationsCompanion(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('title: $title, ')
          ..write('ignoreMemory: $ignoreMemory, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $MessagesTable extends Messages with TableInfo<$MessagesTable, Message> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MessagesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _conversationIdMeta = const VerificationMeta(
    'conversationId',
  );
  @override
  late final GeneratedColumn<String> conversationId = GeneratedColumn<String>(
    'conversation_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES conversations (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _roleMeta = const VerificationMeta('role');
  @override
  late final GeneratedColumn<String> role = GeneratedColumn<String>(
    'role',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _contentMeta = const VerificationMeta(
    'content',
  );
  @override
  late final GeneratedColumn<String> content = GeneratedColumn<String>(
    'content',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _tokenCountMeta = const VerificationMeta(
    'tokenCount',
  );
  @override
  late final GeneratedColumn<int> tokenCount = GeneratedColumn<int>(
    'token_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _seqMeta = const VerificationMeta('seq');
  @override
  late final GeneratedColumn<int> seq = GeneratedColumn<int>(
    'seq',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _metadataMeta = const VerificationMeta(
    'metadata',
  );
  @override
  late final GeneratedColumn<String> metadata = GeneratedColumn<String>(
    'metadata',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('{}'),
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    conversationId,
    role,
    content,
    tokenCount,
    seq,
    createdAt,
    metadata,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'messages';
  @override
  VerificationContext validateIntegrity(
    Insertable<Message> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('conversation_id')) {
      context.handle(
        _conversationIdMeta,
        conversationId.isAcceptableOrUnknown(
          data['conversation_id']!,
          _conversationIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_conversationIdMeta);
    }
    if (data.containsKey('role')) {
      context.handle(
        _roleMeta,
        role.isAcceptableOrUnknown(data['role']!, _roleMeta),
      );
    } else if (isInserting) {
      context.missing(_roleMeta);
    }
    if (data.containsKey('content')) {
      context.handle(
        _contentMeta,
        content.isAcceptableOrUnknown(data['content']!, _contentMeta),
      );
    }
    if (data.containsKey('token_count')) {
      context.handle(
        _tokenCountMeta,
        tokenCount.isAcceptableOrUnknown(data['token_count']!, _tokenCountMeta),
      );
    }
    if (data.containsKey('seq')) {
      context.handle(
        _seqMeta,
        seq.isAcceptableOrUnknown(data['seq']!, _seqMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('metadata')) {
      context.handle(
        _metadataMeta,
        metadata.isAcceptableOrUnknown(data['metadata']!, _metadataMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Message map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Message(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      conversationId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}conversation_id'],
      )!,
      role: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}role'],
      )!,
      content: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}content'],
      )!,
      tokenCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}token_count'],
      )!,
      seq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}seq'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      metadata: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}metadata'],
      )!,
    );
  }

  @override
  $MessagesTable createAlias(String alias) {
    return $MessagesTable(attachedDatabase, alias);
  }
}

class Message extends DataClass implements Insertable<Message> {
  final String id;
  final String conversationId;
  final String role;
  final String content;
  final int tokenCount;
  final int seq;
  final DateTime createdAt;
  final String metadata;
  const Message({
    required this.id,
    required this.conversationId,
    required this.role,
    required this.content,
    required this.tokenCount,
    required this.seq,
    required this.createdAt,
    required this.metadata,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['conversation_id'] = Variable<String>(conversationId);
    map['role'] = Variable<String>(role);
    map['content'] = Variable<String>(content);
    map['token_count'] = Variable<int>(tokenCount);
    map['seq'] = Variable<int>(seq);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['metadata'] = Variable<String>(metadata);
    return map;
  }

  MessagesCompanion toCompanion(bool nullToAbsent) {
    return MessagesCompanion(
      id: Value(id),
      conversationId: Value(conversationId),
      role: Value(role),
      content: Value(content),
      tokenCount: Value(tokenCount),
      seq: Value(seq),
      createdAt: Value(createdAt),
      metadata: Value(metadata),
    );
  }

  factory Message.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Message(
      id: serializer.fromJson<String>(json['id']),
      conversationId: serializer.fromJson<String>(json['conversationId']),
      role: serializer.fromJson<String>(json['role']),
      content: serializer.fromJson<String>(json['content']),
      tokenCount: serializer.fromJson<int>(json['tokenCount']),
      seq: serializer.fromJson<int>(json['seq']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      metadata: serializer.fromJson<String>(json['metadata']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'conversationId': serializer.toJson<String>(conversationId),
      'role': serializer.toJson<String>(role),
      'content': serializer.toJson<String>(content),
      'tokenCount': serializer.toJson<int>(tokenCount),
      'seq': serializer.toJson<int>(seq),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'metadata': serializer.toJson<String>(metadata),
    };
  }

  Message copyWith({
    String? id,
    String? conversationId,
    String? role,
    String? content,
    int? tokenCount,
    int? seq,
    DateTime? createdAt,
    String? metadata,
  }) => Message(
    id: id ?? this.id,
    conversationId: conversationId ?? this.conversationId,
    role: role ?? this.role,
    content: content ?? this.content,
    tokenCount: tokenCount ?? this.tokenCount,
    seq: seq ?? this.seq,
    createdAt: createdAt ?? this.createdAt,
    metadata: metadata ?? this.metadata,
  );
  Message copyWithCompanion(MessagesCompanion data) {
    return Message(
      id: data.id.present ? data.id.value : this.id,
      conversationId: data.conversationId.present
          ? data.conversationId.value
          : this.conversationId,
      role: data.role.present ? data.role.value : this.role,
      content: data.content.present ? data.content.value : this.content,
      tokenCount: data.tokenCount.present
          ? data.tokenCount.value
          : this.tokenCount,
      seq: data.seq.present ? data.seq.value : this.seq,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      metadata: data.metadata.present ? data.metadata.value : this.metadata,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Message(')
          ..write('id: $id, ')
          ..write('conversationId: $conversationId, ')
          ..write('role: $role, ')
          ..write('content: $content, ')
          ..write('tokenCount: $tokenCount, ')
          ..write('seq: $seq, ')
          ..write('createdAt: $createdAt, ')
          ..write('metadata: $metadata')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    conversationId,
    role,
    content,
    tokenCount,
    seq,
    createdAt,
    metadata,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Message &&
          other.id == this.id &&
          other.conversationId == this.conversationId &&
          other.role == this.role &&
          other.content == this.content &&
          other.tokenCount == this.tokenCount &&
          other.seq == this.seq &&
          other.createdAt == this.createdAt &&
          other.metadata == this.metadata);
}

class MessagesCompanion extends UpdateCompanion<Message> {
  final Value<String> id;
  final Value<String> conversationId;
  final Value<String> role;
  final Value<String> content;
  final Value<int> tokenCount;
  final Value<int> seq;
  final Value<DateTime> createdAt;
  final Value<String> metadata;
  final Value<int> rowid;
  const MessagesCompanion({
    this.id = const Value.absent(),
    this.conversationId = const Value.absent(),
    this.role = const Value.absent(),
    this.content = const Value.absent(),
    this.tokenCount = const Value.absent(),
    this.seq = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.metadata = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  MessagesCompanion.insert({
    required String id,
    required String conversationId,
    required String role,
    this.content = const Value.absent(),
    this.tokenCount = const Value.absent(),
    this.seq = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.metadata = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       conversationId = Value(conversationId),
       role = Value(role);
  static Insertable<Message> custom({
    Expression<String>? id,
    Expression<String>? conversationId,
    Expression<String>? role,
    Expression<String>? content,
    Expression<int>? tokenCount,
    Expression<int>? seq,
    Expression<DateTime>? createdAt,
    Expression<String>? metadata,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (conversationId != null) 'conversation_id': conversationId,
      if (role != null) 'role': role,
      if (content != null) 'content': content,
      if (tokenCount != null) 'token_count': tokenCount,
      if (seq != null) 'seq': seq,
      if (createdAt != null) 'created_at': createdAt,
      if (metadata != null) 'metadata': metadata,
      if (rowid != null) 'rowid': rowid,
    });
  }

  MessagesCompanion copyWith({
    Value<String>? id,
    Value<String>? conversationId,
    Value<String>? role,
    Value<String>? content,
    Value<int>? tokenCount,
    Value<int>? seq,
    Value<DateTime>? createdAt,
    Value<String>? metadata,
    Value<int>? rowid,
  }) {
    return MessagesCompanion(
      id: id ?? this.id,
      conversationId: conversationId ?? this.conversationId,
      role: role ?? this.role,
      content: content ?? this.content,
      tokenCount: tokenCount ?? this.tokenCount,
      seq: seq ?? this.seq,
      createdAt: createdAt ?? this.createdAt,
      metadata: metadata ?? this.metadata,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (conversationId.present) {
      map['conversation_id'] = Variable<String>(conversationId.value);
    }
    if (role.present) {
      map['role'] = Variable<String>(role.value);
    }
    if (content.present) {
      map['content'] = Variable<String>(content.value);
    }
    if (tokenCount.present) {
      map['token_count'] = Variable<int>(tokenCount.value);
    }
    if (seq.present) {
      map['seq'] = Variable<int>(seq.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (metadata.present) {
      map['metadata'] = Variable<String>(metadata.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MessagesCompanion(')
          ..write('id: $id, ')
          ..write('conversationId: $conversationId, ')
          ..write('role: $role, ')
          ..write('content: $content, ')
          ..write('tokenCount: $tokenCount, ')
          ..write('seq: $seq, ')
          ..write('createdAt: $createdAt, ')
          ..write('metadata: $metadata, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $MemoriesTable extends Memories with TableInfo<$MemoriesTable, Memory> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MemoriesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _categoryMeta = const VerificationMeta(
    'category',
  );
  @override
  late final GeneratedColumn<String> category = GeneratedColumn<String>(
    'category',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _contentMeta = const VerificationMeta(
    'content',
  );
  @override
  late final GeneratedColumn<String> content = GeneratedColumn<String>(
    'content',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _confidenceMeta = const VerificationMeta(
    'confidence',
  );
  @override
  late final GeneratedColumn<double> confidence = GeneratedColumn<double>(
    'confidence',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0.8),
  );
  static const VerificationMeta _tagsMeta = const VerificationMeta('tags');
  @override
  late final GeneratedColumn<String> tags = GeneratedColumn<String>(
    'tags',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('[]'),
  );
  static const VerificationMeta _sourceMsgIdsMeta = const VerificationMeta(
    'sourceMsgIds',
  );
  @override
  late final GeneratedColumn<String> sourceMsgIds = GeneratedColumn<String>(
    'source_msg_ids',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('[]'),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _memoryKindMeta = const VerificationMeta(
    'memoryKind',
  );
  @override
  late final GeneratedColumn<String> memoryKind = GeneratedColumn<String>(
    'memory_kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('general'),
  );
  static const VerificationMeta _importanceMeta = const VerificationMeta(
    'importance',
  );
  @override
  late final GeneratedColumn<double> importance = GeneratedColumn<double>(
    'importance',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0.5),
  );
  static const VerificationMeta _emotionalWeightMeta = const VerificationMeta(
    'emotionalWeight',
  );
  @override
  late final GeneratedColumn<double> emotionalWeight = GeneratedColumn<double>(
    'emotional_weight',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0.5),
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('active'),
  );
  static const VerificationMeta _pinnedMeta = const VerificationMeta('pinned');
  @override
  late final GeneratedColumn<bool> pinned = GeneratedColumn<bool>(
    'pinned',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("pinned" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _lastUsedAtMeta = const VerificationMeta(
    'lastUsedAt',
  );
  @override
  late final GeneratedColumn<int> lastUsedAt = GeneratedColumn<int>(
    'last_used_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _usageCountMeta = const VerificationMeta(
    'usageCount',
  );
  @override
  late final GeneratedColumn<int> usageCount = GeneratedColumn<int>(
    'usage_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _metadataMeta = const VerificationMeta(
    'metadata',
  );
  @override
  late final GeneratedColumn<String> metadata = GeneratedColumn<String>(
    'metadata',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    characterId,
    category,
    content,
    confidence,
    tags,
    sourceMsgIds,
    createdAt,
    updatedAt,
    memoryKind,
    importance,
    emotionalWeight,
    status,
    pinned,
    lastUsedAt,
    usageCount,
    metadata,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'memories';
  @override
  VerificationContext validateIntegrity(
    Insertable<Memory> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('category')) {
      context.handle(
        _categoryMeta,
        category.isAcceptableOrUnknown(data['category']!, _categoryMeta),
      );
    } else if (isInserting) {
      context.missing(_categoryMeta);
    }
    if (data.containsKey('content')) {
      context.handle(
        _contentMeta,
        content.isAcceptableOrUnknown(data['content']!, _contentMeta),
      );
    } else if (isInserting) {
      context.missing(_contentMeta);
    }
    if (data.containsKey('confidence')) {
      context.handle(
        _confidenceMeta,
        confidence.isAcceptableOrUnknown(data['confidence']!, _confidenceMeta),
      );
    }
    if (data.containsKey('tags')) {
      context.handle(
        _tagsMeta,
        tags.isAcceptableOrUnknown(data['tags']!, _tagsMeta),
      );
    }
    if (data.containsKey('source_msg_ids')) {
      context.handle(
        _sourceMsgIdsMeta,
        sourceMsgIds.isAcceptableOrUnknown(
          data['source_msg_ids']!,
          _sourceMsgIdsMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    if (data.containsKey('memory_kind')) {
      context.handle(
        _memoryKindMeta,
        memoryKind.isAcceptableOrUnknown(data['memory_kind']!, _memoryKindMeta),
      );
    }
    if (data.containsKey('importance')) {
      context.handle(
        _importanceMeta,
        importance.isAcceptableOrUnknown(data['importance']!, _importanceMeta),
      );
    }
    if (data.containsKey('emotional_weight')) {
      context.handle(
        _emotionalWeightMeta,
        emotionalWeight.isAcceptableOrUnknown(
          data['emotional_weight']!,
          _emotionalWeightMeta,
        ),
      );
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('pinned')) {
      context.handle(
        _pinnedMeta,
        pinned.isAcceptableOrUnknown(data['pinned']!, _pinnedMeta),
      );
    }
    if (data.containsKey('last_used_at')) {
      context.handle(
        _lastUsedAtMeta,
        lastUsedAt.isAcceptableOrUnknown(
          data['last_used_at']!,
          _lastUsedAtMeta,
        ),
      );
    }
    if (data.containsKey('usage_count')) {
      context.handle(
        _usageCountMeta,
        usageCount.isAcceptableOrUnknown(data['usage_count']!, _usageCountMeta),
      );
    }
    if (data.containsKey('metadata')) {
      context.handle(
        _metadataMeta,
        metadata.isAcceptableOrUnknown(data['metadata']!, _metadataMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Memory map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Memory(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      category: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}category'],
      )!,
      content: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}content'],
      )!,
      confidence: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}confidence'],
      )!,
      tags: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}tags'],
      )!,
      sourceMsgIds: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}source_msg_ids'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
      memoryKind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}memory_kind'],
      )!,
      importance: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}importance'],
      )!,
      emotionalWeight: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}emotional_weight'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      pinned: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}pinned'],
      )!,
      lastUsedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}last_used_at'],
      ),
      usageCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}usage_count'],
      )!,
      metadata: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}metadata'],
      ),
    );
  }

  @override
  $MemoriesTable createAlias(String alias) {
    return $MemoriesTable(attachedDatabase, alias);
  }
}

class Memory extends DataClass implements Insertable<Memory> {
  final String id;
  final String characterId;
  final String category;
  final String content;
  final double confidence;
  final String tags;
  final String sourceMsgIds;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String memoryKind;
  final double importance;
  final double emotionalWeight;
  final String status;
  final bool pinned;
  final int? lastUsedAt;
  final int usageCount;
  final String? metadata;
  const Memory({
    required this.id,
    required this.characterId,
    required this.category,
    required this.content,
    required this.confidence,
    required this.tags,
    required this.sourceMsgIds,
    required this.createdAt,
    required this.updatedAt,
    required this.memoryKind,
    required this.importance,
    required this.emotionalWeight,
    required this.status,
    required this.pinned,
    this.lastUsedAt,
    required this.usageCount,
    this.metadata,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['character_id'] = Variable<String>(characterId);
    map['category'] = Variable<String>(category);
    map['content'] = Variable<String>(content);
    map['confidence'] = Variable<double>(confidence);
    map['tags'] = Variable<String>(tags);
    map['source_msg_ids'] = Variable<String>(sourceMsgIds);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    map['memory_kind'] = Variable<String>(memoryKind);
    map['importance'] = Variable<double>(importance);
    map['emotional_weight'] = Variable<double>(emotionalWeight);
    map['status'] = Variable<String>(status);
    map['pinned'] = Variable<bool>(pinned);
    if (!nullToAbsent || lastUsedAt != null) {
      map['last_used_at'] = Variable<int>(lastUsedAt);
    }
    map['usage_count'] = Variable<int>(usageCount);
    if (!nullToAbsent || metadata != null) {
      map['metadata'] = Variable<String>(metadata);
    }
    return map;
  }

  MemoriesCompanion toCompanion(bool nullToAbsent) {
    return MemoriesCompanion(
      id: Value(id),
      characterId: Value(characterId),
      category: Value(category),
      content: Value(content),
      confidence: Value(confidence),
      tags: Value(tags),
      sourceMsgIds: Value(sourceMsgIds),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
      memoryKind: Value(memoryKind),
      importance: Value(importance),
      emotionalWeight: Value(emotionalWeight),
      status: Value(status),
      pinned: Value(pinned),
      lastUsedAt: lastUsedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastUsedAt),
      usageCount: Value(usageCount),
      metadata: metadata == null && nullToAbsent
          ? const Value.absent()
          : Value(metadata),
    );
  }

  factory Memory.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Memory(
      id: serializer.fromJson<String>(json['id']),
      characterId: serializer.fromJson<String>(json['characterId']),
      category: serializer.fromJson<String>(json['category']),
      content: serializer.fromJson<String>(json['content']),
      confidence: serializer.fromJson<double>(json['confidence']),
      tags: serializer.fromJson<String>(json['tags']),
      sourceMsgIds: serializer.fromJson<String>(json['sourceMsgIds']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
      memoryKind: serializer.fromJson<String>(json['memoryKind']),
      importance: serializer.fromJson<double>(json['importance']),
      emotionalWeight: serializer.fromJson<double>(json['emotionalWeight']),
      status: serializer.fromJson<String>(json['status']),
      pinned: serializer.fromJson<bool>(json['pinned']),
      lastUsedAt: serializer.fromJson<int?>(json['lastUsedAt']),
      usageCount: serializer.fromJson<int>(json['usageCount']),
      metadata: serializer.fromJson<String?>(json['metadata']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'characterId': serializer.toJson<String>(characterId),
      'category': serializer.toJson<String>(category),
      'content': serializer.toJson<String>(content),
      'confidence': serializer.toJson<double>(confidence),
      'tags': serializer.toJson<String>(tags),
      'sourceMsgIds': serializer.toJson<String>(sourceMsgIds),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
      'memoryKind': serializer.toJson<String>(memoryKind),
      'importance': serializer.toJson<double>(importance),
      'emotionalWeight': serializer.toJson<double>(emotionalWeight),
      'status': serializer.toJson<String>(status),
      'pinned': serializer.toJson<bool>(pinned),
      'lastUsedAt': serializer.toJson<int?>(lastUsedAt),
      'usageCount': serializer.toJson<int>(usageCount),
      'metadata': serializer.toJson<String?>(metadata),
    };
  }

  Memory copyWith({
    String? id,
    String? characterId,
    String? category,
    String? content,
    double? confidence,
    String? tags,
    String? sourceMsgIds,
    DateTime? createdAt,
    DateTime? updatedAt,
    String? memoryKind,
    double? importance,
    double? emotionalWeight,
    String? status,
    bool? pinned,
    Value<int?> lastUsedAt = const Value.absent(),
    int? usageCount,
    Value<String?> metadata = const Value.absent(),
  }) => Memory(
    id: id ?? this.id,
    characterId: characterId ?? this.characterId,
    category: category ?? this.category,
    content: content ?? this.content,
    confidence: confidence ?? this.confidence,
    tags: tags ?? this.tags,
    sourceMsgIds: sourceMsgIds ?? this.sourceMsgIds,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    memoryKind: memoryKind ?? this.memoryKind,
    importance: importance ?? this.importance,
    emotionalWeight: emotionalWeight ?? this.emotionalWeight,
    status: status ?? this.status,
    pinned: pinned ?? this.pinned,
    lastUsedAt: lastUsedAt.present ? lastUsedAt.value : this.lastUsedAt,
    usageCount: usageCount ?? this.usageCount,
    metadata: metadata.present ? metadata.value : this.metadata,
  );
  Memory copyWithCompanion(MemoriesCompanion data) {
    return Memory(
      id: data.id.present ? data.id.value : this.id,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      category: data.category.present ? data.category.value : this.category,
      content: data.content.present ? data.content.value : this.content,
      confidence: data.confidence.present
          ? data.confidence.value
          : this.confidence,
      tags: data.tags.present ? data.tags.value : this.tags,
      sourceMsgIds: data.sourceMsgIds.present
          ? data.sourceMsgIds.value
          : this.sourceMsgIds,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
      memoryKind: data.memoryKind.present
          ? data.memoryKind.value
          : this.memoryKind,
      importance: data.importance.present
          ? data.importance.value
          : this.importance,
      emotionalWeight: data.emotionalWeight.present
          ? data.emotionalWeight.value
          : this.emotionalWeight,
      status: data.status.present ? data.status.value : this.status,
      pinned: data.pinned.present ? data.pinned.value : this.pinned,
      lastUsedAt: data.lastUsedAt.present
          ? data.lastUsedAt.value
          : this.lastUsedAt,
      usageCount: data.usageCount.present
          ? data.usageCount.value
          : this.usageCount,
      metadata: data.metadata.present ? data.metadata.value : this.metadata,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Memory(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('category: $category, ')
          ..write('content: $content, ')
          ..write('confidence: $confidence, ')
          ..write('tags: $tags, ')
          ..write('sourceMsgIds: $sourceMsgIds, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('memoryKind: $memoryKind, ')
          ..write('importance: $importance, ')
          ..write('emotionalWeight: $emotionalWeight, ')
          ..write('status: $status, ')
          ..write('pinned: $pinned, ')
          ..write('lastUsedAt: $lastUsedAt, ')
          ..write('usageCount: $usageCount, ')
          ..write('metadata: $metadata')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    characterId,
    category,
    content,
    confidence,
    tags,
    sourceMsgIds,
    createdAt,
    updatedAt,
    memoryKind,
    importance,
    emotionalWeight,
    status,
    pinned,
    lastUsedAt,
    usageCount,
    metadata,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Memory &&
          other.id == this.id &&
          other.characterId == this.characterId &&
          other.category == this.category &&
          other.content == this.content &&
          other.confidence == this.confidence &&
          other.tags == this.tags &&
          other.sourceMsgIds == this.sourceMsgIds &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt &&
          other.memoryKind == this.memoryKind &&
          other.importance == this.importance &&
          other.emotionalWeight == this.emotionalWeight &&
          other.status == this.status &&
          other.pinned == this.pinned &&
          other.lastUsedAt == this.lastUsedAt &&
          other.usageCount == this.usageCount &&
          other.metadata == this.metadata);
}

class MemoriesCompanion extends UpdateCompanion<Memory> {
  final Value<String> id;
  final Value<String> characterId;
  final Value<String> category;
  final Value<String> content;
  final Value<double> confidence;
  final Value<String> tags;
  final Value<String> sourceMsgIds;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  final Value<String> memoryKind;
  final Value<double> importance;
  final Value<double> emotionalWeight;
  final Value<String> status;
  final Value<bool> pinned;
  final Value<int?> lastUsedAt;
  final Value<int> usageCount;
  final Value<String?> metadata;
  final Value<int> rowid;
  const MemoriesCompanion({
    this.id = const Value.absent(),
    this.characterId = const Value.absent(),
    this.category = const Value.absent(),
    this.content = const Value.absent(),
    this.confidence = const Value.absent(),
    this.tags = const Value.absent(),
    this.sourceMsgIds = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.memoryKind = const Value.absent(),
    this.importance = const Value.absent(),
    this.emotionalWeight = const Value.absent(),
    this.status = const Value.absent(),
    this.pinned = const Value.absent(),
    this.lastUsedAt = const Value.absent(),
    this.usageCount = const Value.absent(),
    this.metadata = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  MemoriesCompanion.insert({
    required String id,
    required String characterId,
    required String category,
    required String content,
    this.confidence = const Value.absent(),
    this.tags = const Value.absent(),
    this.sourceMsgIds = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.memoryKind = const Value.absent(),
    this.importance = const Value.absent(),
    this.emotionalWeight = const Value.absent(),
    this.status = const Value.absent(),
    this.pinned = const Value.absent(),
    this.lastUsedAt = const Value.absent(),
    this.usageCount = const Value.absent(),
    this.metadata = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       characterId = Value(characterId),
       category = Value(category),
       content = Value(content);
  static Insertable<Memory> custom({
    Expression<String>? id,
    Expression<String>? characterId,
    Expression<String>? category,
    Expression<String>? content,
    Expression<double>? confidence,
    Expression<String>? tags,
    Expression<String>? sourceMsgIds,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
    Expression<String>? memoryKind,
    Expression<double>? importance,
    Expression<double>? emotionalWeight,
    Expression<String>? status,
    Expression<bool>? pinned,
    Expression<int>? lastUsedAt,
    Expression<int>? usageCount,
    Expression<String>? metadata,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (characterId != null) 'character_id': characterId,
      if (category != null) 'category': category,
      if (content != null) 'content': content,
      if (confidence != null) 'confidence': confidence,
      if (tags != null) 'tags': tags,
      if (sourceMsgIds != null) 'source_msg_ids': sourceMsgIds,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (memoryKind != null) 'memory_kind': memoryKind,
      if (importance != null) 'importance': importance,
      if (emotionalWeight != null) 'emotional_weight': emotionalWeight,
      if (status != null) 'status': status,
      if (pinned != null) 'pinned': pinned,
      if (lastUsedAt != null) 'last_used_at': lastUsedAt,
      if (usageCount != null) 'usage_count': usageCount,
      if (metadata != null) 'metadata': metadata,
      if (rowid != null) 'rowid': rowid,
    });
  }

  MemoriesCompanion copyWith({
    Value<String>? id,
    Value<String>? characterId,
    Value<String>? category,
    Value<String>? content,
    Value<double>? confidence,
    Value<String>? tags,
    Value<String>? sourceMsgIds,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
    Value<String>? memoryKind,
    Value<double>? importance,
    Value<double>? emotionalWeight,
    Value<String>? status,
    Value<bool>? pinned,
    Value<int?>? lastUsedAt,
    Value<int>? usageCount,
    Value<String?>? metadata,
    Value<int>? rowid,
  }) {
    return MemoriesCompanion(
      id: id ?? this.id,
      characterId: characterId ?? this.characterId,
      category: category ?? this.category,
      content: content ?? this.content,
      confidence: confidence ?? this.confidence,
      tags: tags ?? this.tags,
      sourceMsgIds: sourceMsgIds ?? this.sourceMsgIds,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      memoryKind: memoryKind ?? this.memoryKind,
      importance: importance ?? this.importance,
      emotionalWeight: emotionalWeight ?? this.emotionalWeight,
      status: status ?? this.status,
      pinned: pinned ?? this.pinned,
      lastUsedAt: lastUsedAt ?? this.lastUsedAt,
      usageCount: usageCount ?? this.usageCount,
      metadata: metadata ?? this.metadata,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (category.present) {
      map['category'] = Variable<String>(category.value);
    }
    if (content.present) {
      map['content'] = Variable<String>(content.value);
    }
    if (confidence.present) {
      map['confidence'] = Variable<double>(confidence.value);
    }
    if (tags.present) {
      map['tags'] = Variable<String>(tags.value);
    }
    if (sourceMsgIds.present) {
      map['source_msg_ids'] = Variable<String>(sourceMsgIds.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (memoryKind.present) {
      map['memory_kind'] = Variable<String>(memoryKind.value);
    }
    if (importance.present) {
      map['importance'] = Variable<double>(importance.value);
    }
    if (emotionalWeight.present) {
      map['emotional_weight'] = Variable<double>(emotionalWeight.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (pinned.present) {
      map['pinned'] = Variable<bool>(pinned.value);
    }
    if (lastUsedAt.present) {
      map['last_used_at'] = Variable<int>(lastUsedAt.value);
    }
    if (usageCount.present) {
      map['usage_count'] = Variable<int>(usageCount.value);
    }
    if (metadata.present) {
      map['metadata'] = Variable<String>(metadata.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MemoriesCompanion(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('category: $category, ')
          ..write('content: $content, ')
          ..write('confidence: $confidence, ')
          ..write('tags: $tags, ')
          ..write('sourceMsgIds: $sourceMsgIds, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('memoryKind: $memoryKind, ')
          ..write('importance: $importance, ')
          ..write('emotionalWeight: $emotionalWeight, ')
          ..write('status: $status, ')
          ..write('pinned: $pinned, ')
          ..write('lastUsedAt: $lastUsedAt, ')
          ..write('usageCount: $usageCount, ')
          ..write('metadata: $metadata, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $SettingsTable extends Settings with TableInfo<$SettingsTable, Setting> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $SettingsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _keyMeta = const VerificationMeta('key');
  @override
  late final GeneratedColumn<String> key = GeneratedColumn<String>(
    'key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _valueMeta = const VerificationMeta('value');
  @override
  late final GeneratedColumn<String> value = GeneratedColumn<String>(
    'value',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [key, value];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'settings';
  @override
  VerificationContext validateIntegrity(
    Insertable<Setting> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('key')) {
      context.handle(
        _keyMeta,
        key.isAcceptableOrUnknown(data['key']!, _keyMeta),
      );
    } else if (isInserting) {
      context.missing(_keyMeta);
    }
    if (data.containsKey('value')) {
      context.handle(
        _valueMeta,
        value.isAcceptableOrUnknown(data['value']!, _valueMeta),
      );
    } else if (isInserting) {
      context.missing(_valueMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {key};
  @override
  Setting map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Setting(
      key: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}key'],
      )!,
      value: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}value'],
      )!,
    );
  }

  @override
  $SettingsTable createAlias(String alias) {
    return $SettingsTable(attachedDatabase, alias);
  }
}

class Setting extends DataClass implements Insertable<Setting> {
  final String key;
  final String value;
  const Setting({required this.key, required this.value});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['key'] = Variable<String>(key);
    map['value'] = Variable<String>(value);
    return map;
  }

  SettingsCompanion toCompanion(bool nullToAbsent) {
    return SettingsCompanion(key: Value(key), value: Value(value));
  }

  factory Setting.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Setting(
      key: serializer.fromJson<String>(json['key']),
      value: serializer.fromJson<String>(json['value']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'key': serializer.toJson<String>(key),
      'value': serializer.toJson<String>(value),
    };
  }

  Setting copyWith({String? key, String? value}) =>
      Setting(key: key ?? this.key, value: value ?? this.value);
  Setting copyWithCompanion(SettingsCompanion data) {
    return Setting(
      key: data.key.present ? data.key.value : this.key,
      value: data.value.present ? data.value.value : this.value,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Setting(')
          ..write('key: $key, ')
          ..write('value: $value')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(key, value);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Setting && other.key == this.key && other.value == this.value);
}

class SettingsCompanion extends UpdateCompanion<Setting> {
  final Value<String> key;
  final Value<String> value;
  final Value<int> rowid;
  const SettingsCompanion({
    this.key = const Value.absent(),
    this.value = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  SettingsCompanion.insert({
    required String key,
    required String value,
    this.rowid = const Value.absent(),
  }) : key = Value(key),
       value = Value(value);
  static Insertable<Setting> custom({
    Expression<String>? key,
    Expression<String>? value,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (key != null) 'key': key,
      if (value != null) 'value': value,
      if (rowid != null) 'rowid': rowid,
    });
  }

  SettingsCompanion copyWith({
    Value<String>? key,
    Value<String>? value,
    Value<int>? rowid,
  }) {
    return SettingsCompanion(
      key: key ?? this.key,
      value: value ?? this.value,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (key.present) {
      map['key'] = Variable<String>(key.value);
    }
    if (value.present) {
      map['value'] = Variable<String>(value.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('SettingsCompanion(')
          ..write('key: $key, ')
          ..write('value: $value, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $MemoryTasksTable extends MemoryTasks
    with TableInfo<$MemoryTasksTable, MemoryTask> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MemoryTasksTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _conversationIdMeta = const VerificationMeta(
    'conversationId',
  );
  @override
  late final GeneratedColumn<String> conversationId = GeneratedColumn<String>(
    'conversation_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES conversations (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _messageIdsMeta = const VerificationMeta(
    'messageIds',
  );
  @override
  late final GeneratedColumn<String> messageIds = GeneratedColumn<String>(
    'message_ids',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('[]'),
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('pending'),
  );
  static const VerificationMeta _mergeCountMeta = const VerificationMeta(
    'mergeCount',
  );
  @override
  late final GeneratedColumn<int> mergeCount = GeneratedColumn<int>(
    'merge_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _startedAtMeta = const VerificationMeta(
    'startedAt',
  );
  @override
  late final GeneratedColumn<int> startedAt = GeneratedColumn<int>(
    'started_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _retryCountMeta = const VerificationMeta(
    'retryCount',
  );
  @override
  late final GeneratedColumn<int> retryCount = GeneratedColumn<int>(
    'retry_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _errorMessageMeta = const VerificationMeta(
    'errorMessage',
  );
  @override
  late final GeneratedColumn<String> errorMessage = GeneratedColumn<String>(
    'error_message',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    characterId,
    conversationId,
    messageIds,
    status,
    mergeCount,
    createdAt,
    updatedAt,
    startedAt,
    retryCount,
    errorMessage,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'memory_tasks';
  @override
  VerificationContext validateIntegrity(
    Insertable<MemoryTask> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('conversation_id')) {
      context.handle(
        _conversationIdMeta,
        conversationId.isAcceptableOrUnknown(
          data['conversation_id']!,
          _conversationIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_conversationIdMeta);
    }
    if (data.containsKey('message_ids')) {
      context.handle(
        _messageIdsMeta,
        messageIds.isAcceptableOrUnknown(data['message_ids']!, _messageIdsMeta),
      );
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('merge_count')) {
      context.handle(
        _mergeCountMeta,
        mergeCount.isAcceptableOrUnknown(data['merge_count']!, _mergeCountMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    if (data.containsKey('started_at')) {
      context.handle(
        _startedAtMeta,
        startedAt.isAcceptableOrUnknown(data['started_at']!, _startedAtMeta),
      );
    }
    if (data.containsKey('retry_count')) {
      context.handle(
        _retryCountMeta,
        retryCount.isAcceptableOrUnknown(data['retry_count']!, _retryCountMeta),
      );
    }
    if (data.containsKey('error_message')) {
      context.handle(
        _errorMessageMeta,
        errorMessage.isAcceptableOrUnknown(
          data['error_message']!,
          _errorMessageMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  MemoryTask map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return MemoryTask(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      conversationId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}conversation_id'],
      )!,
      messageIds: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}message_ids'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      mergeCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}merge_count'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
      startedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}started_at'],
      ),
      retryCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}retry_count'],
      )!,
      errorMessage: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}error_message'],
      ),
    );
  }

  @override
  $MemoryTasksTable createAlias(String alias) {
    return $MemoryTasksTable(attachedDatabase, alias);
  }
}

class MemoryTask extends DataClass implements Insertable<MemoryTask> {
  final int id;
  final String characterId;
  final String conversationId;
  final String messageIds;
  final String status;
  final int mergeCount;
  final DateTime createdAt;
  final DateTime updatedAt;
  final int? startedAt;
  final int retryCount;
  final String? errorMessage;
  const MemoryTask({
    required this.id,
    required this.characterId,
    required this.conversationId,
    required this.messageIds,
    required this.status,
    required this.mergeCount,
    required this.createdAt,
    required this.updatedAt,
    this.startedAt,
    required this.retryCount,
    this.errorMessage,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['character_id'] = Variable<String>(characterId);
    map['conversation_id'] = Variable<String>(conversationId);
    map['message_ids'] = Variable<String>(messageIds);
    map['status'] = Variable<String>(status);
    map['merge_count'] = Variable<int>(mergeCount);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    if (!nullToAbsent || startedAt != null) {
      map['started_at'] = Variable<int>(startedAt);
    }
    map['retry_count'] = Variable<int>(retryCount);
    if (!nullToAbsent || errorMessage != null) {
      map['error_message'] = Variable<String>(errorMessage);
    }
    return map;
  }

  MemoryTasksCompanion toCompanion(bool nullToAbsent) {
    return MemoryTasksCompanion(
      id: Value(id),
      characterId: Value(characterId),
      conversationId: Value(conversationId),
      messageIds: Value(messageIds),
      status: Value(status),
      mergeCount: Value(mergeCount),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
      startedAt: startedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(startedAt),
      retryCount: Value(retryCount),
      errorMessage: errorMessage == null && nullToAbsent
          ? const Value.absent()
          : Value(errorMessage),
    );
  }

  factory MemoryTask.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return MemoryTask(
      id: serializer.fromJson<int>(json['id']),
      characterId: serializer.fromJson<String>(json['characterId']),
      conversationId: serializer.fromJson<String>(json['conversationId']),
      messageIds: serializer.fromJson<String>(json['messageIds']),
      status: serializer.fromJson<String>(json['status']),
      mergeCount: serializer.fromJson<int>(json['mergeCount']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
      startedAt: serializer.fromJson<int?>(json['startedAt']),
      retryCount: serializer.fromJson<int>(json['retryCount']),
      errorMessage: serializer.fromJson<String?>(json['errorMessage']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'characterId': serializer.toJson<String>(characterId),
      'conversationId': serializer.toJson<String>(conversationId),
      'messageIds': serializer.toJson<String>(messageIds),
      'status': serializer.toJson<String>(status),
      'mergeCount': serializer.toJson<int>(mergeCount),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
      'startedAt': serializer.toJson<int?>(startedAt),
      'retryCount': serializer.toJson<int>(retryCount),
      'errorMessage': serializer.toJson<String?>(errorMessage),
    };
  }

  MemoryTask copyWith({
    int? id,
    String? characterId,
    String? conversationId,
    String? messageIds,
    String? status,
    int? mergeCount,
    DateTime? createdAt,
    DateTime? updatedAt,
    Value<int?> startedAt = const Value.absent(),
    int? retryCount,
    Value<String?> errorMessage = const Value.absent(),
  }) => MemoryTask(
    id: id ?? this.id,
    characterId: characterId ?? this.characterId,
    conversationId: conversationId ?? this.conversationId,
    messageIds: messageIds ?? this.messageIds,
    status: status ?? this.status,
    mergeCount: mergeCount ?? this.mergeCount,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    startedAt: startedAt.present ? startedAt.value : this.startedAt,
    retryCount: retryCount ?? this.retryCount,
    errorMessage: errorMessage.present ? errorMessage.value : this.errorMessage,
  );
  MemoryTask copyWithCompanion(MemoryTasksCompanion data) {
    return MemoryTask(
      id: data.id.present ? data.id.value : this.id,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      conversationId: data.conversationId.present
          ? data.conversationId.value
          : this.conversationId,
      messageIds: data.messageIds.present
          ? data.messageIds.value
          : this.messageIds,
      status: data.status.present ? data.status.value : this.status,
      mergeCount: data.mergeCount.present
          ? data.mergeCount.value
          : this.mergeCount,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
      startedAt: data.startedAt.present ? data.startedAt.value : this.startedAt,
      retryCount: data.retryCount.present
          ? data.retryCount.value
          : this.retryCount,
      errorMessage: data.errorMessage.present
          ? data.errorMessage.value
          : this.errorMessage,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MemoryTask(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('conversationId: $conversationId, ')
          ..write('messageIds: $messageIds, ')
          ..write('status: $status, ')
          ..write('mergeCount: $mergeCount, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('startedAt: $startedAt, ')
          ..write('retryCount: $retryCount, ')
          ..write('errorMessage: $errorMessage')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    characterId,
    conversationId,
    messageIds,
    status,
    mergeCount,
    createdAt,
    updatedAt,
    startedAt,
    retryCount,
    errorMessage,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MemoryTask &&
          other.id == this.id &&
          other.characterId == this.characterId &&
          other.conversationId == this.conversationId &&
          other.messageIds == this.messageIds &&
          other.status == this.status &&
          other.mergeCount == this.mergeCount &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt &&
          other.startedAt == this.startedAt &&
          other.retryCount == this.retryCount &&
          other.errorMessage == this.errorMessage);
}

class MemoryTasksCompanion extends UpdateCompanion<MemoryTask> {
  final Value<int> id;
  final Value<String> characterId;
  final Value<String> conversationId;
  final Value<String> messageIds;
  final Value<String> status;
  final Value<int> mergeCount;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  final Value<int?> startedAt;
  final Value<int> retryCount;
  final Value<String?> errorMessage;
  const MemoryTasksCompanion({
    this.id = const Value.absent(),
    this.characterId = const Value.absent(),
    this.conversationId = const Value.absent(),
    this.messageIds = const Value.absent(),
    this.status = const Value.absent(),
    this.mergeCount = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.startedAt = const Value.absent(),
    this.retryCount = const Value.absent(),
    this.errorMessage = const Value.absent(),
  });
  MemoryTasksCompanion.insert({
    this.id = const Value.absent(),
    required String characterId,
    required String conversationId,
    this.messageIds = const Value.absent(),
    this.status = const Value.absent(),
    this.mergeCount = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.startedAt = const Value.absent(),
    this.retryCount = const Value.absent(),
    this.errorMessage = const Value.absent(),
  }) : characterId = Value(characterId),
       conversationId = Value(conversationId);
  static Insertable<MemoryTask> custom({
    Expression<int>? id,
    Expression<String>? characterId,
    Expression<String>? conversationId,
    Expression<String>? messageIds,
    Expression<String>? status,
    Expression<int>? mergeCount,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
    Expression<int>? startedAt,
    Expression<int>? retryCount,
    Expression<String>? errorMessage,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (characterId != null) 'character_id': characterId,
      if (conversationId != null) 'conversation_id': conversationId,
      if (messageIds != null) 'message_ids': messageIds,
      if (status != null) 'status': status,
      if (mergeCount != null) 'merge_count': mergeCount,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (startedAt != null) 'started_at': startedAt,
      if (retryCount != null) 'retry_count': retryCount,
      if (errorMessage != null) 'error_message': errorMessage,
    });
  }

  MemoryTasksCompanion copyWith({
    Value<int>? id,
    Value<String>? characterId,
    Value<String>? conversationId,
    Value<String>? messageIds,
    Value<String>? status,
    Value<int>? mergeCount,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
    Value<int?>? startedAt,
    Value<int>? retryCount,
    Value<String?>? errorMessage,
  }) {
    return MemoryTasksCompanion(
      id: id ?? this.id,
      characterId: characterId ?? this.characterId,
      conversationId: conversationId ?? this.conversationId,
      messageIds: messageIds ?? this.messageIds,
      status: status ?? this.status,
      mergeCount: mergeCount ?? this.mergeCount,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      startedAt: startedAt ?? this.startedAt,
      retryCount: retryCount ?? this.retryCount,
      errorMessage: errorMessage ?? this.errorMessage,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (conversationId.present) {
      map['conversation_id'] = Variable<String>(conversationId.value);
    }
    if (messageIds.present) {
      map['message_ids'] = Variable<String>(messageIds.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (mergeCount.present) {
      map['merge_count'] = Variable<int>(mergeCount.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (startedAt.present) {
      map['started_at'] = Variable<int>(startedAt.value);
    }
    if (retryCount.present) {
      map['retry_count'] = Variable<int>(retryCount.value);
    }
    if (errorMessage.present) {
      map['error_message'] = Variable<String>(errorMessage.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MemoryTasksCompanion(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('conversationId: $conversationId, ')
          ..write('messageIds: $messageIds, ')
          ..write('status: $status, ')
          ..write('mergeCount: $mergeCount, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('startedAt: $startedAt, ')
          ..write('retryCount: $retryCount, ')
          ..write('errorMessage: $errorMessage')
          ..write(')'))
        .toString();
  }
}

class $ModelCacheTable extends ModelCache
    with TableInfo<$ModelCacheTable, ModelCacheData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ModelCacheTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _apiBaseMeta = const VerificationMeta(
    'apiBase',
  );
  @override
  late final GeneratedColumn<String> apiBase = GeneratedColumn<String>(
    'api_base',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _modelsMeta = const VerificationMeta('models');
  @override
  late final GeneratedColumn<String> models = GeneratedColumn<String>(
    'models',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('[]'),
  );
  static const VerificationMeta _cachedAtMeta = const VerificationMeta(
    'cachedAt',
  );
  @override
  late final GeneratedColumn<DateTime> cachedAt = GeneratedColumn<DateTime>(
    'cached_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [apiBase, models, cachedAt];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'model_cache';
  @override
  VerificationContext validateIntegrity(
    Insertable<ModelCacheData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('api_base')) {
      context.handle(
        _apiBaseMeta,
        apiBase.isAcceptableOrUnknown(data['api_base']!, _apiBaseMeta),
      );
    } else if (isInserting) {
      context.missing(_apiBaseMeta);
    }
    if (data.containsKey('models')) {
      context.handle(
        _modelsMeta,
        models.isAcceptableOrUnknown(data['models']!, _modelsMeta),
      );
    }
    if (data.containsKey('cached_at')) {
      context.handle(
        _cachedAtMeta,
        cachedAt.isAcceptableOrUnknown(data['cached_at']!, _cachedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {apiBase};
  @override
  ModelCacheData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ModelCacheData(
      apiBase: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}api_base'],
      )!,
      models: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}models'],
      )!,
      cachedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}cached_at'],
      )!,
    );
  }

  @override
  $ModelCacheTable createAlias(String alias) {
    return $ModelCacheTable(attachedDatabase, alias);
  }
}

class ModelCacheData extends DataClass implements Insertable<ModelCacheData> {
  final String apiBase;
  final String models;
  final DateTime cachedAt;
  const ModelCacheData({
    required this.apiBase,
    required this.models,
    required this.cachedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['api_base'] = Variable<String>(apiBase);
    map['models'] = Variable<String>(models);
    map['cached_at'] = Variable<DateTime>(cachedAt);
    return map;
  }

  ModelCacheCompanion toCompanion(bool nullToAbsent) {
    return ModelCacheCompanion(
      apiBase: Value(apiBase),
      models: Value(models),
      cachedAt: Value(cachedAt),
    );
  }

  factory ModelCacheData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ModelCacheData(
      apiBase: serializer.fromJson<String>(json['apiBase']),
      models: serializer.fromJson<String>(json['models']),
      cachedAt: serializer.fromJson<DateTime>(json['cachedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'apiBase': serializer.toJson<String>(apiBase),
      'models': serializer.toJson<String>(models),
      'cachedAt': serializer.toJson<DateTime>(cachedAt),
    };
  }

  ModelCacheData copyWith({
    String? apiBase,
    String? models,
    DateTime? cachedAt,
  }) => ModelCacheData(
    apiBase: apiBase ?? this.apiBase,
    models: models ?? this.models,
    cachedAt: cachedAt ?? this.cachedAt,
  );
  ModelCacheData copyWithCompanion(ModelCacheCompanion data) {
    return ModelCacheData(
      apiBase: data.apiBase.present ? data.apiBase.value : this.apiBase,
      models: data.models.present ? data.models.value : this.models,
      cachedAt: data.cachedAt.present ? data.cachedAt.value : this.cachedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ModelCacheData(')
          ..write('apiBase: $apiBase, ')
          ..write('models: $models, ')
          ..write('cachedAt: $cachedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(apiBase, models, cachedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ModelCacheData &&
          other.apiBase == this.apiBase &&
          other.models == this.models &&
          other.cachedAt == this.cachedAt);
}

class ModelCacheCompanion extends UpdateCompanion<ModelCacheData> {
  final Value<String> apiBase;
  final Value<String> models;
  final Value<DateTime> cachedAt;
  final Value<int> rowid;
  const ModelCacheCompanion({
    this.apiBase = const Value.absent(),
    this.models = const Value.absent(),
    this.cachedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ModelCacheCompanion.insert({
    required String apiBase,
    this.models = const Value.absent(),
    this.cachedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : apiBase = Value(apiBase);
  static Insertable<ModelCacheData> custom({
    Expression<String>? apiBase,
    Expression<String>? models,
    Expression<DateTime>? cachedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (apiBase != null) 'api_base': apiBase,
      if (models != null) 'models': models,
      if (cachedAt != null) 'cached_at': cachedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ModelCacheCompanion copyWith({
    Value<String>? apiBase,
    Value<String>? models,
    Value<DateTime>? cachedAt,
    Value<int>? rowid,
  }) {
    return ModelCacheCompanion(
      apiBase: apiBase ?? this.apiBase,
      models: models ?? this.models,
      cachedAt: cachedAt ?? this.cachedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (apiBase.present) {
      map['api_base'] = Variable<String>(apiBase.value);
    }
    if (models.present) {
      map['models'] = Variable<String>(models.value);
    }
    if (cachedAt.present) {
      map['cached_at'] = Variable<DateTime>(cachedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ModelCacheCompanion(')
          ..write('apiBase: $apiBase, ')
          ..write('models: $models, ')
          ..write('cachedAt: $cachedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ApiProvidersTable extends ApiProviders
    with TableInfo<$ApiProvidersTable, ApiProvider> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ApiProvidersTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _apiBaseMeta = const VerificationMeta(
    'apiBase',
  );
  @override
  late final GeneratedColumn<String> apiBase = GeneratedColumn<String>(
    'api_base',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _apiKeyMeta = const VerificationMeta('apiKey');
  @override
  late final GeneratedColumn<String> apiKey = GeneratedColumn<String>(
    'api_key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _modelMeta = const VerificationMeta('model');
  @override
  late final GeneratedColumn<String> model = GeneratedColumn<String>(
    'model',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _temperatureMeta = const VerificationMeta(
    'temperature',
  );
  @override
  late final GeneratedColumn<double> temperature = GeneratedColumn<double>(
    'temperature',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(1.0),
  );
  static const VerificationMeta _maxTokensMeta = const VerificationMeta(
    'maxTokens',
  );
  @override
  late final GeneratedColumn<int> maxTokens = GeneratedColumn<int>(
    'max_tokens',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(4096),
  );
  static const VerificationMeta _contextWindowMeta = const VerificationMeta(
    'contextWindow',
  );
  @override
  late final GeneratedColumn<int> contextWindow = GeneratedColumn<int>(
    'context_window',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(131072),
  );
  static const VerificationMeta _jsonModeMeta = const VerificationMeta(
    'jsonMode',
  );
  @override
  late final GeneratedColumn<int> jsonMode = GeneratedColumn<int>(
    'json_mode',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    name,
    apiBase,
    apiKey,
    model,
    temperature,
    maxTokens,
    contextWindow,
    jsonMode,
    createdAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'api_providers';
  @override
  VerificationContext validateIntegrity(
    Insertable<ApiProvider> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('api_base')) {
      context.handle(
        _apiBaseMeta,
        apiBase.isAcceptableOrUnknown(data['api_base']!, _apiBaseMeta),
      );
    }
    if (data.containsKey('api_key')) {
      context.handle(
        _apiKeyMeta,
        apiKey.isAcceptableOrUnknown(data['api_key']!, _apiKeyMeta),
      );
    }
    if (data.containsKey('model')) {
      context.handle(
        _modelMeta,
        model.isAcceptableOrUnknown(data['model']!, _modelMeta),
      );
    }
    if (data.containsKey('temperature')) {
      context.handle(
        _temperatureMeta,
        temperature.isAcceptableOrUnknown(
          data['temperature']!,
          _temperatureMeta,
        ),
      );
    }
    if (data.containsKey('max_tokens')) {
      context.handle(
        _maxTokensMeta,
        maxTokens.isAcceptableOrUnknown(data['max_tokens']!, _maxTokensMeta),
      );
    }
    if (data.containsKey('context_window')) {
      context.handle(
        _contextWindowMeta,
        contextWindow.isAcceptableOrUnknown(
          data['context_window']!,
          _contextWindowMeta,
        ),
      );
    }
    if (data.containsKey('json_mode')) {
      context.handle(
        _jsonModeMeta,
        jsonMode.isAcceptableOrUnknown(data['json_mode']!, _jsonModeMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  ApiProvider map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ApiProvider(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      apiBase: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}api_base'],
      )!,
      apiKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}api_key'],
      )!,
      model: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}model'],
      )!,
      temperature: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}temperature'],
      )!,
      maxTokens: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}max_tokens'],
      )!,
      contextWindow: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}context_window'],
      )!,
      jsonMode: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}json_mode'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
    );
  }

  @override
  $ApiProvidersTable createAlias(String alias) {
    return $ApiProvidersTable(attachedDatabase, alias);
  }
}

class ApiProvider extends DataClass implements Insertable<ApiProvider> {
  final String id;
  final String name;
  final String apiBase;
  final String apiKey;
  final String model;
  final double temperature;
  final int maxTokens;
  final int contextWindow;
  final int jsonMode;
  final DateTime createdAt;
  const ApiProvider({
    required this.id,
    required this.name,
    required this.apiBase,
    required this.apiKey,
    required this.model,
    required this.temperature,
    required this.maxTokens,
    required this.contextWindow,
    required this.jsonMode,
    required this.createdAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['name'] = Variable<String>(name);
    map['api_base'] = Variable<String>(apiBase);
    map['api_key'] = Variable<String>(apiKey);
    map['model'] = Variable<String>(model);
    map['temperature'] = Variable<double>(temperature);
    map['max_tokens'] = Variable<int>(maxTokens);
    map['context_window'] = Variable<int>(contextWindow);
    map['json_mode'] = Variable<int>(jsonMode);
    map['created_at'] = Variable<DateTime>(createdAt);
    return map;
  }

  ApiProvidersCompanion toCompanion(bool nullToAbsent) {
    return ApiProvidersCompanion(
      id: Value(id),
      name: Value(name),
      apiBase: Value(apiBase),
      apiKey: Value(apiKey),
      model: Value(model),
      temperature: Value(temperature),
      maxTokens: Value(maxTokens),
      contextWindow: Value(contextWindow),
      jsonMode: Value(jsonMode),
      createdAt: Value(createdAt),
    );
  }

  factory ApiProvider.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ApiProvider(
      id: serializer.fromJson<String>(json['id']),
      name: serializer.fromJson<String>(json['name']),
      apiBase: serializer.fromJson<String>(json['apiBase']),
      apiKey: serializer.fromJson<String>(json['apiKey']),
      model: serializer.fromJson<String>(json['model']),
      temperature: serializer.fromJson<double>(json['temperature']),
      maxTokens: serializer.fromJson<int>(json['maxTokens']),
      contextWindow: serializer.fromJson<int>(json['contextWindow']),
      jsonMode: serializer.fromJson<int>(json['jsonMode']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'name': serializer.toJson<String>(name),
      'apiBase': serializer.toJson<String>(apiBase),
      'apiKey': serializer.toJson<String>(apiKey),
      'model': serializer.toJson<String>(model),
      'temperature': serializer.toJson<double>(temperature),
      'maxTokens': serializer.toJson<int>(maxTokens),
      'contextWindow': serializer.toJson<int>(contextWindow),
      'jsonMode': serializer.toJson<int>(jsonMode),
      'createdAt': serializer.toJson<DateTime>(createdAt),
    };
  }

  ApiProvider copyWith({
    String? id,
    String? name,
    String? apiBase,
    String? apiKey,
    String? model,
    double? temperature,
    int? maxTokens,
    int? contextWindow,
    int? jsonMode,
    DateTime? createdAt,
  }) => ApiProvider(
    id: id ?? this.id,
    name: name ?? this.name,
    apiBase: apiBase ?? this.apiBase,
    apiKey: apiKey ?? this.apiKey,
    model: model ?? this.model,
    temperature: temperature ?? this.temperature,
    maxTokens: maxTokens ?? this.maxTokens,
    contextWindow: contextWindow ?? this.contextWindow,
    jsonMode: jsonMode ?? this.jsonMode,
    createdAt: createdAt ?? this.createdAt,
  );
  ApiProvider copyWithCompanion(ApiProvidersCompanion data) {
    return ApiProvider(
      id: data.id.present ? data.id.value : this.id,
      name: data.name.present ? data.name.value : this.name,
      apiBase: data.apiBase.present ? data.apiBase.value : this.apiBase,
      apiKey: data.apiKey.present ? data.apiKey.value : this.apiKey,
      model: data.model.present ? data.model.value : this.model,
      temperature: data.temperature.present
          ? data.temperature.value
          : this.temperature,
      maxTokens: data.maxTokens.present ? data.maxTokens.value : this.maxTokens,
      contextWindow: data.contextWindow.present
          ? data.contextWindow.value
          : this.contextWindow,
      jsonMode: data.jsonMode.present ? data.jsonMode.value : this.jsonMode,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ApiProvider(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('apiBase: $apiBase, ')
          ..write('apiKey: $apiKey, ')
          ..write('model: $model, ')
          ..write('temperature: $temperature, ')
          ..write('maxTokens: $maxTokens, ')
          ..write('contextWindow: $contextWindow, ')
          ..write('jsonMode: $jsonMode, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    name,
    apiBase,
    apiKey,
    model,
    temperature,
    maxTokens,
    contextWindow,
    jsonMode,
    createdAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ApiProvider &&
          other.id == this.id &&
          other.name == this.name &&
          other.apiBase == this.apiBase &&
          other.apiKey == this.apiKey &&
          other.model == this.model &&
          other.temperature == this.temperature &&
          other.maxTokens == this.maxTokens &&
          other.contextWindow == this.contextWindow &&
          other.jsonMode == this.jsonMode &&
          other.createdAt == this.createdAt);
}

class ApiProvidersCompanion extends UpdateCompanion<ApiProvider> {
  final Value<String> id;
  final Value<String> name;
  final Value<String> apiBase;
  final Value<String> apiKey;
  final Value<String> model;
  final Value<double> temperature;
  final Value<int> maxTokens;
  final Value<int> contextWindow;
  final Value<int> jsonMode;
  final Value<DateTime> createdAt;
  final Value<int> rowid;
  const ApiProvidersCompanion({
    this.id = const Value.absent(),
    this.name = const Value.absent(),
    this.apiBase = const Value.absent(),
    this.apiKey = const Value.absent(),
    this.model = const Value.absent(),
    this.temperature = const Value.absent(),
    this.maxTokens = const Value.absent(),
    this.contextWindow = const Value.absent(),
    this.jsonMode = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ApiProvidersCompanion.insert({
    required String id,
    required String name,
    this.apiBase = const Value.absent(),
    this.apiKey = const Value.absent(),
    this.model = const Value.absent(),
    this.temperature = const Value.absent(),
    this.maxTokens = const Value.absent(),
    this.contextWindow = const Value.absent(),
    this.jsonMode = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       name = Value(name);
  static Insertable<ApiProvider> custom({
    Expression<String>? id,
    Expression<String>? name,
    Expression<String>? apiBase,
    Expression<String>? apiKey,
    Expression<String>? model,
    Expression<double>? temperature,
    Expression<int>? maxTokens,
    Expression<int>? contextWindow,
    Expression<int>? jsonMode,
    Expression<DateTime>? createdAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (name != null) 'name': name,
      if (apiBase != null) 'api_base': apiBase,
      if (apiKey != null) 'api_key': apiKey,
      if (model != null) 'model': model,
      if (temperature != null) 'temperature': temperature,
      if (maxTokens != null) 'max_tokens': maxTokens,
      if (contextWindow != null) 'context_window': contextWindow,
      if (jsonMode != null) 'json_mode': jsonMode,
      if (createdAt != null) 'created_at': createdAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ApiProvidersCompanion copyWith({
    Value<String>? id,
    Value<String>? name,
    Value<String>? apiBase,
    Value<String>? apiKey,
    Value<String>? model,
    Value<double>? temperature,
    Value<int>? maxTokens,
    Value<int>? contextWindow,
    Value<int>? jsonMode,
    Value<DateTime>? createdAt,
    Value<int>? rowid,
  }) {
    return ApiProvidersCompanion(
      id: id ?? this.id,
      name: name ?? this.name,
      apiBase: apiBase ?? this.apiBase,
      apiKey: apiKey ?? this.apiKey,
      model: model ?? this.model,
      temperature: temperature ?? this.temperature,
      maxTokens: maxTokens ?? this.maxTokens,
      contextWindow: contextWindow ?? this.contextWindow,
      jsonMode: jsonMode ?? this.jsonMode,
      createdAt: createdAt ?? this.createdAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (apiBase.present) {
      map['api_base'] = Variable<String>(apiBase.value);
    }
    if (apiKey.present) {
      map['api_key'] = Variable<String>(apiKey.value);
    }
    if (model.present) {
      map['model'] = Variable<String>(model.value);
    }
    if (temperature.present) {
      map['temperature'] = Variable<double>(temperature.value);
    }
    if (maxTokens.present) {
      map['max_tokens'] = Variable<int>(maxTokens.value);
    }
    if (contextWindow.present) {
      map['context_window'] = Variable<int>(contextWindow.value);
    }
    if (jsonMode.present) {
      map['json_mode'] = Variable<int>(jsonMode.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ApiProvidersCompanion(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('apiBase: $apiBase, ')
          ..write('apiKey: $apiKey, ')
          ..write('model: $model, ')
          ..write('temperature: $temperature, ')
          ..write('maxTokens: $maxTokens, ')
          ..write('contextWindow: $contextWindow, ')
          ..write('jsonMode: $jsonMode, ')
          ..write('createdAt: $createdAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $MemoryEmbeddingsTable extends MemoryEmbeddings
    with TableInfo<$MemoryEmbeddingsTable, MemoryEmbedding> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MemoryEmbeddingsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _memoryIdMeta = const VerificationMeta(
    'memoryId',
  );
  @override
  late final GeneratedColumn<String> memoryId = GeneratedColumn<String>(
    'memory_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES memories (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _providerMeta = const VerificationMeta(
    'provider',
  );
  @override
  late final GeneratedColumn<String> provider = GeneratedColumn<String>(
    'provider',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _modelMeta = const VerificationMeta('model');
  @override
  late final GeneratedColumn<String> model = GeneratedColumn<String>(
    'model',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _dimensionMeta = const VerificationMeta(
    'dimension',
  );
  @override
  late final GeneratedColumn<int> dimension = GeneratedColumn<int>(
    'dimension',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _embeddingBlobMeta = const VerificationMeta(
    'embeddingBlob',
  );
  @override
  late final GeneratedColumn<Uint8List> embeddingBlob =
      GeneratedColumn<Uint8List>(
        'embedding_blob',
        aliasedName,
        false,
        type: DriftSqlType.blob,
        requiredDuringInsert: true,
      );
  static const VerificationMeta _normalizedMeta = const VerificationMeta(
    'normalized',
  );
  @override
  late final GeneratedColumn<int> normalized = GeneratedColumn<int>(
    'normalized',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(1),
  );
  static const VerificationMeta _embeddingTextHashMeta = const VerificationMeta(
    'embeddingTextHash',
  );
  @override
  late final GeneratedColumn<String> embeddingTextHash =
      GeneratedColumn<String>(
        'embedding_text_hash',
        aliasedName,
        false,
        type: DriftSqlType.string,
        requiredDuringInsert: true,
      );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('ready'),
  );
  static const VerificationMeta _errorMessageMeta = const VerificationMeta(
    'errorMessage',
  );
  @override
  late final GeneratedColumn<String> errorMessage = GeneratedColumn<String>(
    'error_message',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    memoryId,
    characterId,
    provider,
    model,
    dimension,
    embeddingBlob,
    normalized,
    embeddingTextHash,
    status,
    errorMessage,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'memory_embeddings';
  @override
  VerificationContext validateIntegrity(
    Insertable<MemoryEmbedding> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('memory_id')) {
      context.handle(
        _memoryIdMeta,
        memoryId.isAcceptableOrUnknown(data['memory_id']!, _memoryIdMeta),
      );
    } else if (isInserting) {
      context.missing(_memoryIdMeta);
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('provider')) {
      context.handle(
        _providerMeta,
        provider.isAcceptableOrUnknown(data['provider']!, _providerMeta),
      );
    } else if (isInserting) {
      context.missing(_providerMeta);
    }
    if (data.containsKey('model')) {
      context.handle(
        _modelMeta,
        model.isAcceptableOrUnknown(data['model']!, _modelMeta),
      );
    } else if (isInserting) {
      context.missing(_modelMeta);
    }
    if (data.containsKey('dimension')) {
      context.handle(
        _dimensionMeta,
        dimension.isAcceptableOrUnknown(data['dimension']!, _dimensionMeta),
      );
    } else if (isInserting) {
      context.missing(_dimensionMeta);
    }
    if (data.containsKey('embedding_blob')) {
      context.handle(
        _embeddingBlobMeta,
        embeddingBlob.isAcceptableOrUnknown(
          data['embedding_blob']!,
          _embeddingBlobMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_embeddingBlobMeta);
    }
    if (data.containsKey('normalized')) {
      context.handle(
        _normalizedMeta,
        normalized.isAcceptableOrUnknown(data['normalized']!, _normalizedMeta),
      );
    }
    if (data.containsKey('embedding_text_hash')) {
      context.handle(
        _embeddingTextHashMeta,
        embeddingTextHash.isAcceptableOrUnknown(
          data['embedding_text_hash']!,
          _embeddingTextHashMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_embeddingTextHashMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('error_message')) {
      context.handle(
        _errorMessageMeta,
        errorMessage.isAcceptableOrUnknown(
          data['error_message']!,
          _errorMessageMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  MemoryEmbedding map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return MemoryEmbedding(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      memoryId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}memory_id'],
      )!,
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      provider: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}provider'],
      )!,
      model: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}model'],
      )!,
      dimension: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}dimension'],
      )!,
      embeddingBlob: attachedDatabase.typeMapping.read(
        DriftSqlType.blob,
        data['${effectivePrefix}embedding_blob'],
      )!,
      normalized: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}normalized'],
      )!,
      embeddingTextHash: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}embedding_text_hash'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      errorMessage: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}error_message'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $MemoryEmbeddingsTable createAlias(String alias) {
    return $MemoryEmbeddingsTable(attachedDatabase, alias);
  }
}

class MemoryEmbedding extends DataClass implements Insertable<MemoryEmbedding> {
  final int id;
  final String memoryId;
  final String characterId;
  final String provider;
  final String model;
  final int dimension;
  final Uint8List embeddingBlob;
  final int normalized;
  final String embeddingTextHash;
  final String status;
  final String? errorMessage;
  final DateTime createdAt;
  final DateTime updatedAt;
  const MemoryEmbedding({
    required this.id,
    required this.memoryId,
    required this.characterId,
    required this.provider,
    required this.model,
    required this.dimension,
    required this.embeddingBlob,
    required this.normalized,
    required this.embeddingTextHash,
    required this.status,
    this.errorMessage,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['memory_id'] = Variable<String>(memoryId);
    map['character_id'] = Variable<String>(characterId);
    map['provider'] = Variable<String>(provider);
    map['model'] = Variable<String>(model);
    map['dimension'] = Variable<int>(dimension);
    map['embedding_blob'] = Variable<Uint8List>(embeddingBlob);
    map['normalized'] = Variable<int>(normalized);
    map['embedding_text_hash'] = Variable<String>(embeddingTextHash);
    map['status'] = Variable<String>(status);
    if (!nullToAbsent || errorMessage != null) {
      map['error_message'] = Variable<String>(errorMessage);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  MemoryEmbeddingsCompanion toCompanion(bool nullToAbsent) {
    return MemoryEmbeddingsCompanion(
      id: Value(id),
      memoryId: Value(memoryId),
      characterId: Value(characterId),
      provider: Value(provider),
      model: Value(model),
      dimension: Value(dimension),
      embeddingBlob: Value(embeddingBlob),
      normalized: Value(normalized),
      embeddingTextHash: Value(embeddingTextHash),
      status: Value(status),
      errorMessage: errorMessage == null && nullToAbsent
          ? const Value.absent()
          : Value(errorMessage),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory MemoryEmbedding.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return MemoryEmbedding(
      id: serializer.fromJson<int>(json['id']),
      memoryId: serializer.fromJson<String>(json['memoryId']),
      characterId: serializer.fromJson<String>(json['characterId']),
      provider: serializer.fromJson<String>(json['provider']),
      model: serializer.fromJson<String>(json['model']),
      dimension: serializer.fromJson<int>(json['dimension']),
      embeddingBlob: serializer.fromJson<Uint8List>(json['embeddingBlob']),
      normalized: serializer.fromJson<int>(json['normalized']),
      embeddingTextHash: serializer.fromJson<String>(json['embeddingTextHash']),
      status: serializer.fromJson<String>(json['status']),
      errorMessage: serializer.fromJson<String?>(json['errorMessage']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'memoryId': serializer.toJson<String>(memoryId),
      'characterId': serializer.toJson<String>(characterId),
      'provider': serializer.toJson<String>(provider),
      'model': serializer.toJson<String>(model),
      'dimension': serializer.toJson<int>(dimension),
      'embeddingBlob': serializer.toJson<Uint8List>(embeddingBlob),
      'normalized': serializer.toJson<int>(normalized),
      'embeddingTextHash': serializer.toJson<String>(embeddingTextHash),
      'status': serializer.toJson<String>(status),
      'errorMessage': serializer.toJson<String?>(errorMessage),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  MemoryEmbedding copyWith({
    int? id,
    String? memoryId,
    String? characterId,
    String? provider,
    String? model,
    int? dimension,
    Uint8List? embeddingBlob,
    int? normalized,
    String? embeddingTextHash,
    String? status,
    Value<String?> errorMessage = const Value.absent(),
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => MemoryEmbedding(
    id: id ?? this.id,
    memoryId: memoryId ?? this.memoryId,
    characterId: characterId ?? this.characterId,
    provider: provider ?? this.provider,
    model: model ?? this.model,
    dimension: dimension ?? this.dimension,
    embeddingBlob: embeddingBlob ?? this.embeddingBlob,
    normalized: normalized ?? this.normalized,
    embeddingTextHash: embeddingTextHash ?? this.embeddingTextHash,
    status: status ?? this.status,
    errorMessage: errorMessage.present ? errorMessage.value : this.errorMessage,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  MemoryEmbedding copyWithCompanion(MemoryEmbeddingsCompanion data) {
    return MemoryEmbedding(
      id: data.id.present ? data.id.value : this.id,
      memoryId: data.memoryId.present ? data.memoryId.value : this.memoryId,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      provider: data.provider.present ? data.provider.value : this.provider,
      model: data.model.present ? data.model.value : this.model,
      dimension: data.dimension.present ? data.dimension.value : this.dimension,
      embeddingBlob: data.embeddingBlob.present
          ? data.embeddingBlob.value
          : this.embeddingBlob,
      normalized: data.normalized.present
          ? data.normalized.value
          : this.normalized,
      embeddingTextHash: data.embeddingTextHash.present
          ? data.embeddingTextHash.value
          : this.embeddingTextHash,
      status: data.status.present ? data.status.value : this.status,
      errorMessage: data.errorMessage.present
          ? data.errorMessage.value
          : this.errorMessage,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MemoryEmbedding(')
          ..write('id: $id, ')
          ..write('memoryId: $memoryId, ')
          ..write('characterId: $characterId, ')
          ..write('provider: $provider, ')
          ..write('model: $model, ')
          ..write('dimension: $dimension, ')
          ..write('embeddingBlob: $embeddingBlob, ')
          ..write('normalized: $normalized, ')
          ..write('embeddingTextHash: $embeddingTextHash, ')
          ..write('status: $status, ')
          ..write('errorMessage: $errorMessage, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    memoryId,
    characterId,
    provider,
    model,
    dimension,
    $driftBlobEquality.hash(embeddingBlob),
    normalized,
    embeddingTextHash,
    status,
    errorMessage,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MemoryEmbedding &&
          other.id == this.id &&
          other.memoryId == this.memoryId &&
          other.characterId == this.characterId &&
          other.provider == this.provider &&
          other.model == this.model &&
          other.dimension == this.dimension &&
          $driftBlobEquality.equals(other.embeddingBlob, this.embeddingBlob) &&
          other.normalized == this.normalized &&
          other.embeddingTextHash == this.embeddingTextHash &&
          other.status == this.status &&
          other.errorMessage == this.errorMessage &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class MemoryEmbeddingsCompanion extends UpdateCompanion<MemoryEmbedding> {
  final Value<int> id;
  final Value<String> memoryId;
  final Value<String> characterId;
  final Value<String> provider;
  final Value<String> model;
  final Value<int> dimension;
  final Value<Uint8List> embeddingBlob;
  final Value<int> normalized;
  final Value<String> embeddingTextHash;
  final Value<String> status;
  final Value<String?> errorMessage;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  const MemoryEmbeddingsCompanion({
    this.id = const Value.absent(),
    this.memoryId = const Value.absent(),
    this.characterId = const Value.absent(),
    this.provider = const Value.absent(),
    this.model = const Value.absent(),
    this.dimension = const Value.absent(),
    this.embeddingBlob = const Value.absent(),
    this.normalized = const Value.absent(),
    this.embeddingTextHash = const Value.absent(),
    this.status = const Value.absent(),
    this.errorMessage = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  });
  MemoryEmbeddingsCompanion.insert({
    this.id = const Value.absent(),
    required String memoryId,
    required String characterId,
    required String provider,
    required String model,
    required int dimension,
    required Uint8List embeddingBlob,
    this.normalized = const Value.absent(),
    required String embeddingTextHash,
    this.status = const Value.absent(),
    this.errorMessage = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  }) : memoryId = Value(memoryId),
       characterId = Value(characterId),
       provider = Value(provider),
       model = Value(model),
       dimension = Value(dimension),
       embeddingBlob = Value(embeddingBlob),
       embeddingTextHash = Value(embeddingTextHash);
  static Insertable<MemoryEmbedding> custom({
    Expression<int>? id,
    Expression<String>? memoryId,
    Expression<String>? characterId,
    Expression<String>? provider,
    Expression<String>? model,
    Expression<int>? dimension,
    Expression<Uint8List>? embeddingBlob,
    Expression<int>? normalized,
    Expression<String>? embeddingTextHash,
    Expression<String>? status,
    Expression<String>? errorMessage,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (memoryId != null) 'memory_id': memoryId,
      if (characterId != null) 'character_id': characterId,
      if (provider != null) 'provider': provider,
      if (model != null) 'model': model,
      if (dimension != null) 'dimension': dimension,
      if (embeddingBlob != null) 'embedding_blob': embeddingBlob,
      if (normalized != null) 'normalized': normalized,
      if (embeddingTextHash != null) 'embedding_text_hash': embeddingTextHash,
      if (status != null) 'status': status,
      if (errorMessage != null) 'error_message': errorMessage,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
    });
  }

  MemoryEmbeddingsCompanion copyWith({
    Value<int>? id,
    Value<String>? memoryId,
    Value<String>? characterId,
    Value<String>? provider,
    Value<String>? model,
    Value<int>? dimension,
    Value<Uint8List>? embeddingBlob,
    Value<int>? normalized,
    Value<String>? embeddingTextHash,
    Value<String>? status,
    Value<String?>? errorMessage,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
  }) {
    return MemoryEmbeddingsCompanion(
      id: id ?? this.id,
      memoryId: memoryId ?? this.memoryId,
      characterId: characterId ?? this.characterId,
      provider: provider ?? this.provider,
      model: model ?? this.model,
      dimension: dimension ?? this.dimension,
      embeddingBlob: embeddingBlob ?? this.embeddingBlob,
      normalized: normalized ?? this.normalized,
      embeddingTextHash: embeddingTextHash ?? this.embeddingTextHash,
      status: status ?? this.status,
      errorMessage: errorMessage ?? this.errorMessage,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (memoryId.present) {
      map['memory_id'] = Variable<String>(memoryId.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (provider.present) {
      map['provider'] = Variable<String>(provider.value);
    }
    if (model.present) {
      map['model'] = Variable<String>(model.value);
    }
    if (dimension.present) {
      map['dimension'] = Variable<int>(dimension.value);
    }
    if (embeddingBlob.present) {
      map['embedding_blob'] = Variable<Uint8List>(embeddingBlob.value);
    }
    if (normalized.present) {
      map['normalized'] = Variable<int>(normalized.value);
    }
    if (embeddingTextHash.present) {
      map['embedding_text_hash'] = Variable<String>(embeddingTextHash.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (errorMessage.present) {
      map['error_message'] = Variable<String>(errorMessage.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MemoryEmbeddingsCompanion(')
          ..write('id: $id, ')
          ..write('memoryId: $memoryId, ')
          ..write('characterId: $characterId, ')
          ..write('provider: $provider, ')
          ..write('model: $model, ')
          ..write('dimension: $dimension, ')
          ..write('embeddingBlob: $embeddingBlob, ')
          ..write('normalized: $normalized, ')
          ..write('embeddingTextHash: $embeddingTextHash, ')
          ..write('status: $status, ')
          ..write('errorMessage: $errorMessage, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }
}

class $MemoryEmbeddingTasksTable extends MemoryEmbeddingTasks
    with TableInfo<$MemoryEmbeddingTasksTable, MemoryEmbeddingTask> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MemoryEmbeddingTasksTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _memoryIdMeta = const VerificationMeta(
    'memoryId',
  );
  @override
  late final GeneratedColumn<String> memoryId = GeneratedColumn<String>(
    'memory_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES memories (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _reasonMeta = const VerificationMeta('reason');
  @override
  late final GeneratedColumn<String> reason = GeneratedColumn<String>(
    'reason',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('pending'),
  );
  static const VerificationMeta _claimTokenMeta = const VerificationMeta(
    'claimToken',
  );
  @override
  late final GeneratedColumn<String> claimToken = GeneratedColumn<String>(
    'claim_token',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _retryCountMeta = const VerificationMeta(
    'retryCount',
  );
  @override
  late final GeneratedColumn<int> retryCount = GeneratedColumn<int>(
    'retry_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _errorMessageMeta = const VerificationMeta(
    'errorMessage',
  );
  @override
  late final GeneratedColumn<String> errorMessage = GeneratedColumn<String>(
    'error_message',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    memoryId,
    characterId,
    reason,
    status,
    claimToken,
    retryCount,
    errorMessage,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'memory_embedding_tasks';
  @override
  VerificationContext validateIntegrity(
    Insertable<MemoryEmbeddingTask> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('memory_id')) {
      context.handle(
        _memoryIdMeta,
        memoryId.isAcceptableOrUnknown(data['memory_id']!, _memoryIdMeta),
      );
    } else if (isInserting) {
      context.missing(_memoryIdMeta);
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('reason')) {
      context.handle(
        _reasonMeta,
        reason.isAcceptableOrUnknown(data['reason']!, _reasonMeta),
      );
    } else if (isInserting) {
      context.missing(_reasonMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('claim_token')) {
      context.handle(
        _claimTokenMeta,
        claimToken.isAcceptableOrUnknown(data['claim_token']!, _claimTokenMeta),
      );
    }
    if (data.containsKey('retry_count')) {
      context.handle(
        _retryCountMeta,
        retryCount.isAcceptableOrUnknown(data['retry_count']!, _retryCountMeta),
      );
    }
    if (data.containsKey('error_message')) {
      context.handle(
        _errorMessageMeta,
        errorMessage.isAcceptableOrUnknown(
          data['error_message']!,
          _errorMessageMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  MemoryEmbeddingTask map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return MemoryEmbeddingTask(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      memoryId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}memory_id'],
      )!,
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      reason: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reason'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      claimToken: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}claim_token'],
      ),
      retryCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}retry_count'],
      )!,
      errorMessage: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}error_message'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $MemoryEmbeddingTasksTable createAlias(String alias) {
    return $MemoryEmbeddingTasksTable(attachedDatabase, alias);
  }
}

class MemoryEmbeddingTask extends DataClass
    implements Insertable<MemoryEmbeddingTask> {
  final int id;
  final String memoryId;
  final String characterId;
  final String reason;
  final String status;
  final String? claimToken;
  final int retryCount;
  final String? errorMessage;
  final DateTime createdAt;
  final DateTime updatedAt;
  const MemoryEmbeddingTask({
    required this.id,
    required this.memoryId,
    required this.characterId,
    required this.reason,
    required this.status,
    this.claimToken,
    required this.retryCount,
    this.errorMessage,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['memory_id'] = Variable<String>(memoryId);
    map['character_id'] = Variable<String>(characterId);
    map['reason'] = Variable<String>(reason);
    map['status'] = Variable<String>(status);
    if (!nullToAbsent || claimToken != null) {
      map['claim_token'] = Variable<String>(claimToken);
    }
    map['retry_count'] = Variable<int>(retryCount);
    if (!nullToAbsent || errorMessage != null) {
      map['error_message'] = Variable<String>(errorMessage);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  MemoryEmbeddingTasksCompanion toCompanion(bool nullToAbsent) {
    return MemoryEmbeddingTasksCompanion(
      id: Value(id),
      memoryId: Value(memoryId),
      characterId: Value(characterId),
      reason: Value(reason),
      status: Value(status),
      claimToken: claimToken == null && nullToAbsent
          ? const Value.absent()
          : Value(claimToken),
      retryCount: Value(retryCount),
      errorMessage: errorMessage == null && nullToAbsent
          ? const Value.absent()
          : Value(errorMessage),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory MemoryEmbeddingTask.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return MemoryEmbeddingTask(
      id: serializer.fromJson<int>(json['id']),
      memoryId: serializer.fromJson<String>(json['memoryId']),
      characterId: serializer.fromJson<String>(json['characterId']),
      reason: serializer.fromJson<String>(json['reason']),
      status: serializer.fromJson<String>(json['status']),
      claimToken: serializer.fromJson<String?>(json['claimToken']),
      retryCount: serializer.fromJson<int>(json['retryCount']),
      errorMessage: serializer.fromJson<String?>(json['errorMessage']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'memoryId': serializer.toJson<String>(memoryId),
      'characterId': serializer.toJson<String>(characterId),
      'reason': serializer.toJson<String>(reason),
      'status': serializer.toJson<String>(status),
      'claimToken': serializer.toJson<String?>(claimToken),
      'retryCount': serializer.toJson<int>(retryCount),
      'errorMessage': serializer.toJson<String?>(errorMessage),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  MemoryEmbeddingTask copyWith({
    int? id,
    String? memoryId,
    String? characterId,
    String? reason,
    String? status,
    Value<String?> claimToken = const Value.absent(),
    int? retryCount,
    Value<String?> errorMessage = const Value.absent(),
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => MemoryEmbeddingTask(
    id: id ?? this.id,
    memoryId: memoryId ?? this.memoryId,
    characterId: characterId ?? this.characterId,
    reason: reason ?? this.reason,
    status: status ?? this.status,
    claimToken: claimToken.present ? claimToken.value : this.claimToken,
    retryCount: retryCount ?? this.retryCount,
    errorMessage: errorMessage.present ? errorMessage.value : this.errorMessage,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  MemoryEmbeddingTask copyWithCompanion(MemoryEmbeddingTasksCompanion data) {
    return MemoryEmbeddingTask(
      id: data.id.present ? data.id.value : this.id,
      memoryId: data.memoryId.present ? data.memoryId.value : this.memoryId,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      reason: data.reason.present ? data.reason.value : this.reason,
      status: data.status.present ? data.status.value : this.status,
      claimToken: data.claimToken.present
          ? data.claimToken.value
          : this.claimToken,
      retryCount: data.retryCount.present
          ? data.retryCount.value
          : this.retryCount,
      errorMessage: data.errorMessage.present
          ? data.errorMessage.value
          : this.errorMessage,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MemoryEmbeddingTask(')
          ..write('id: $id, ')
          ..write('memoryId: $memoryId, ')
          ..write('characterId: $characterId, ')
          ..write('reason: $reason, ')
          ..write('status: $status, ')
          ..write('claimToken: $claimToken, ')
          ..write('retryCount: $retryCount, ')
          ..write('errorMessage: $errorMessage, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    memoryId,
    characterId,
    reason,
    status,
    claimToken,
    retryCount,
    errorMessage,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MemoryEmbeddingTask &&
          other.id == this.id &&
          other.memoryId == this.memoryId &&
          other.characterId == this.characterId &&
          other.reason == this.reason &&
          other.status == this.status &&
          other.claimToken == this.claimToken &&
          other.retryCount == this.retryCount &&
          other.errorMessage == this.errorMessage &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class MemoryEmbeddingTasksCompanion
    extends UpdateCompanion<MemoryEmbeddingTask> {
  final Value<int> id;
  final Value<String> memoryId;
  final Value<String> characterId;
  final Value<String> reason;
  final Value<String> status;
  final Value<String?> claimToken;
  final Value<int> retryCount;
  final Value<String?> errorMessage;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  const MemoryEmbeddingTasksCompanion({
    this.id = const Value.absent(),
    this.memoryId = const Value.absent(),
    this.characterId = const Value.absent(),
    this.reason = const Value.absent(),
    this.status = const Value.absent(),
    this.claimToken = const Value.absent(),
    this.retryCount = const Value.absent(),
    this.errorMessage = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  });
  MemoryEmbeddingTasksCompanion.insert({
    this.id = const Value.absent(),
    required String memoryId,
    required String characterId,
    required String reason,
    this.status = const Value.absent(),
    this.claimToken = const Value.absent(),
    this.retryCount = const Value.absent(),
    this.errorMessage = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  }) : memoryId = Value(memoryId),
       characterId = Value(characterId),
       reason = Value(reason);
  static Insertable<MemoryEmbeddingTask> custom({
    Expression<int>? id,
    Expression<String>? memoryId,
    Expression<String>? characterId,
    Expression<String>? reason,
    Expression<String>? status,
    Expression<String>? claimToken,
    Expression<int>? retryCount,
    Expression<String>? errorMessage,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (memoryId != null) 'memory_id': memoryId,
      if (characterId != null) 'character_id': characterId,
      if (reason != null) 'reason': reason,
      if (status != null) 'status': status,
      if (claimToken != null) 'claim_token': claimToken,
      if (retryCount != null) 'retry_count': retryCount,
      if (errorMessage != null) 'error_message': errorMessage,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
    });
  }

  MemoryEmbeddingTasksCompanion copyWith({
    Value<int>? id,
    Value<String>? memoryId,
    Value<String>? characterId,
    Value<String>? reason,
    Value<String>? status,
    Value<String?>? claimToken,
    Value<int>? retryCount,
    Value<String?>? errorMessage,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
  }) {
    return MemoryEmbeddingTasksCompanion(
      id: id ?? this.id,
      memoryId: memoryId ?? this.memoryId,
      characterId: characterId ?? this.characterId,
      reason: reason ?? this.reason,
      status: status ?? this.status,
      claimToken: claimToken ?? this.claimToken,
      retryCount: retryCount ?? this.retryCount,
      errorMessage: errorMessage ?? this.errorMessage,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (memoryId.present) {
      map['memory_id'] = Variable<String>(memoryId.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (reason.present) {
      map['reason'] = Variable<String>(reason.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (claimToken.present) {
      map['claim_token'] = Variable<String>(claimToken.value);
    }
    if (retryCount.present) {
      map['retry_count'] = Variable<int>(retryCount.value);
    }
    if (errorMessage.present) {
      map['error_message'] = Variable<String>(errorMessage.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MemoryEmbeddingTasksCompanion(')
          ..write('id: $id, ')
          ..write('memoryId: $memoryId, ')
          ..write('characterId: $characterId, ')
          ..write('reason: $reason, ')
          ..write('status: $status, ')
          ..write('claimToken: $claimToken, ')
          ..write('retryCount: $retryCount, ')
          ..write('errorMessage: $errorMessage, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }
}

class $CharacterMemoryProfilesTable extends CharacterMemoryProfiles
    with TableInfo<$CharacterMemoryProfilesTable, CharacterMemoryProfile> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CharacterMemoryProfilesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _profileNameMeta = const VerificationMeta(
    'profileName',
  );
  @override
  late final GeneratedColumn<String> profileName = GeneratedColumn<String>(
    'profile_name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _relationshipStateMeta = const VerificationMeta(
    'relationshipState',
  );
  @override
  late final GeneratedColumn<String> relationshipState =
      GeneratedColumn<String>(
        'relationship_state',
        aliasedName,
        false,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
        defaultValue: const Constant(''),
      );
  static const VerificationMeta _recentStoryStateMeta = const VerificationMeta(
    'recentStoryState',
  );
  @override
  late final GeneratedColumn<String> recentStoryState = GeneratedColumn<String>(
    'recent_story_state',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _emotionalBaselineMeta = const VerificationMeta(
    'emotionalBaseline',
  );
  @override
  late final GeneratedColumn<String> emotionalBaseline =
      GeneratedColumn<String>(
        'emotional_baseline',
        aliasedName,
        false,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
        defaultValue: const Constant(''),
      );
  static const VerificationMeta _openThreadsMeta = const VerificationMeta(
    'openThreads',
  );
  @override
  late final GeneratedColumn<String> openThreads = GeneratedColumn<String>(
    'open_threads',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('[]'),
  );
  static const VerificationMeta _userProfileSummaryMeta =
      const VerificationMeta('userProfileSummary');
  @override
  late final GeneratedColumn<String> userProfileSummary =
      GeneratedColumn<String>(
        'user_profile_summary',
        aliasedName,
        false,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
        defaultValue: const Constant(''),
      );
  static const VerificationMeta _pinnedSummaryMeta = const VerificationMeta(
    'pinnedSummary',
  );
  @override
  late final GeneratedColumn<String> pinnedSummary = GeneratedColumn<String>(
    'pinned_summary',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant(''),
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    characterId,
    profileName,
    relationshipState,
    recentStoryState,
    emotionalBaseline,
    openThreads,
    userProfileSummary,
    pinnedSummary,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'character_memory_profiles';
  @override
  VerificationContext validateIntegrity(
    Insertable<CharacterMemoryProfile> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('profile_name')) {
      context.handle(
        _profileNameMeta,
        profileName.isAcceptableOrUnknown(
          data['profile_name']!,
          _profileNameMeta,
        ),
      );
    }
    if (data.containsKey('relationship_state')) {
      context.handle(
        _relationshipStateMeta,
        relationshipState.isAcceptableOrUnknown(
          data['relationship_state']!,
          _relationshipStateMeta,
        ),
      );
    }
    if (data.containsKey('recent_story_state')) {
      context.handle(
        _recentStoryStateMeta,
        recentStoryState.isAcceptableOrUnknown(
          data['recent_story_state']!,
          _recentStoryStateMeta,
        ),
      );
    }
    if (data.containsKey('emotional_baseline')) {
      context.handle(
        _emotionalBaselineMeta,
        emotionalBaseline.isAcceptableOrUnknown(
          data['emotional_baseline']!,
          _emotionalBaselineMeta,
        ),
      );
    }
    if (data.containsKey('open_threads')) {
      context.handle(
        _openThreadsMeta,
        openThreads.isAcceptableOrUnknown(
          data['open_threads']!,
          _openThreadsMeta,
        ),
      );
    }
    if (data.containsKey('user_profile_summary')) {
      context.handle(
        _userProfileSummaryMeta,
        userProfileSummary.isAcceptableOrUnknown(
          data['user_profile_summary']!,
          _userProfileSummaryMeta,
        ),
      );
    }
    if (data.containsKey('pinned_summary')) {
      context.handle(
        _pinnedSummaryMeta,
        pinnedSummary.isAcceptableOrUnknown(
          data['pinned_summary']!,
          _pinnedSummaryMeta,
        ),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {characterId};
  @override
  CharacterMemoryProfile map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CharacterMemoryProfile(
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      profileName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}profile_name'],
      )!,
      relationshipState: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}relationship_state'],
      )!,
      recentStoryState: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}recent_story_state'],
      )!,
      emotionalBaseline: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}emotional_baseline'],
      )!,
      openThreads: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}open_threads'],
      )!,
      userProfileSummary: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}user_profile_summary'],
      )!,
      pinnedSummary: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}pinned_summary'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $CharacterMemoryProfilesTable createAlias(String alias) {
    return $CharacterMemoryProfilesTable(attachedDatabase, alias);
  }
}

class CharacterMemoryProfile extends DataClass
    implements Insertable<CharacterMemoryProfile> {
  final String characterId;
  final String profileName;
  final String relationshipState;
  final String recentStoryState;
  final String emotionalBaseline;
  final String openThreads;
  final String userProfileSummary;
  final String pinnedSummary;
  final DateTime updatedAt;
  const CharacterMemoryProfile({
    required this.characterId,
    required this.profileName,
    required this.relationshipState,
    required this.recentStoryState,
    required this.emotionalBaseline,
    required this.openThreads,
    required this.userProfileSummary,
    required this.pinnedSummary,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['character_id'] = Variable<String>(characterId);
    map['profile_name'] = Variable<String>(profileName);
    map['relationship_state'] = Variable<String>(relationshipState);
    map['recent_story_state'] = Variable<String>(recentStoryState);
    map['emotional_baseline'] = Variable<String>(emotionalBaseline);
    map['open_threads'] = Variable<String>(openThreads);
    map['user_profile_summary'] = Variable<String>(userProfileSummary);
    map['pinned_summary'] = Variable<String>(pinnedSummary);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  CharacterMemoryProfilesCompanion toCompanion(bool nullToAbsent) {
    return CharacterMemoryProfilesCompanion(
      characterId: Value(characterId),
      profileName: Value(profileName),
      relationshipState: Value(relationshipState),
      recentStoryState: Value(recentStoryState),
      emotionalBaseline: Value(emotionalBaseline),
      openThreads: Value(openThreads),
      userProfileSummary: Value(userProfileSummary),
      pinnedSummary: Value(pinnedSummary),
      updatedAt: Value(updatedAt),
    );
  }

  factory CharacterMemoryProfile.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CharacterMemoryProfile(
      characterId: serializer.fromJson<String>(json['characterId']),
      profileName: serializer.fromJson<String>(json['profileName']),
      relationshipState: serializer.fromJson<String>(json['relationshipState']),
      recentStoryState: serializer.fromJson<String>(json['recentStoryState']),
      emotionalBaseline: serializer.fromJson<String>(json['emotionalBaseline']),
      openThreads: serializer.fromJson<String>(json['openThreads']),
      userProfileSummary: serializer.fromJson<String>(
        json['userProfileSummary'],
      ),
      pinnedSummary: serializer.fromJson<String>(json['pinnedSummary']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'characterId': serializer.toJson<String>(characterId),
      'profileName': serializer.toJson<String>(profileName),
      'relationshipState': serializer.toJson<String>(relationshipState),
      'recentStoryState': serializer.toJson<String>(recentStoryState),
      'emotionalBaseline': serializer.toJson<String>(emotionalBaseline),
      'openThreads': serializer.toJson<String>(openThreads),
      'userProfileSummary': serializer.toJson<String>(userProfileSummary),
      'pinnedSummary': serializer.toJson<String>(pinnedSummary),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  CharacterMemoryProfile copyWith({
    String? characterId,
    String? profileName,
    String? relationshipState,
    String? recentStoryState,
    String? emotionalBaseline,
    String? openThreads,
    String? userProfileSummary,
    String? pinnedSummary,
    DateTime? updatedAt,
  }) => CharacterMemoryProfile(
    characterId: characterId ?? this.characterId,
    profileName: profileName ?? this.profileName,
    relationshipState: relationshipState ?? this.relationshipState,
    recentStoryState: recentStoryState ?? this.recentStoryState,
    emotionalBaseline: emotionalBaseline ?? this.emotionalBaseline,
    openThreads: openThreads ?? this.openThreads,
    userProfileSummary: userProfileSummary ?? this.userProfileSummary,
    pinnedSummary: pinnedSummary ?? this.pinnedSummary,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  CharacterMemoryProfile copyWithCompanion(
    CharacterMemoryProfilesCompanion data,
  ) {
    return CharacterMemoryProfile(
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      profileName: data.profileName.present
          ? data.profileName.value
          : this.profileName,
      relationshipState: data.relationshipState.present
          ? data.relationshipState.value
          : this.relationshipState,
      recentStoryState: data.recentStoryState.present
          ? data.recentStoryState.value
          : this.recentStoryState,
      emotionalBaseline: data.emotionalBaseline.present
          ? data.emotionalBaseline.value
          : this.emotionalBaseline,
      openThreads: data.openThreads.present
          ? data.openThreads.value
          : this.openThreads,
      userProfileSummary: data.userProfileSummary.present
          ? data.userProfileSummary.value
          : this.userProfileSummary,
      pinnedSummary: data.pinnedSummary.present
          ? data.pinnedSummary.value
          : this.pinnedSummary,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CharacterMemoryProfile(')
          ..write('characterId: $characterId, ')
          ..write('profileName: $profileName, ')
          ..write('relationshipState: $relationshipState, ')
          ..write('recentStoryState: $recentStoryState, ')
          ..write('emotionalBaseline: $emotionalBaseline, ')
          ..write('openThreads: $openThreads, ')
          ..write('userProfileSummary: $userProfileSummary, ')
          ..write('pinnedSummary: $pinnedSummary, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    characterId,
    profileName,
    relationshipState,
    recentStoryState,
    emotionalBaseline,
    openThreads,
    userProfileSummary,
    pinnedSummary,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CharacterMemoryProfile &&
          other.characterId == this.characterId &&
          other.profileName == this.profileName &&
          other.relationshipState == this.relationshipState &&
          other.recentStoryState == this.recentStoryState &&
          other.emotionalBaseline == this.emotionalBaseline &&
          other.openThreads == this.openThreads &&
          other.userProfileSummary == this.userProfileSummary &&
          other.pinnedSummary == this.pinnedSummary &&
          other.updatedAt == this.updatedAt);
}

class CharacterMemoryProfilesCompanion
    extends UpdateCompanion<CharacterMemoryProfile> {
  final Value<String> characterId;
  final Value<String> profileName;
  final Value<String> relationshipState;
  final Value<String> recentStoryState;
  final Value<String> emotionalBaseline;
  final Value<String> openThreads;
  final Value<String> userProfileSummary;
  final Value<String> pinnedSummary;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const CharacterMemoryProfilesCompanion({
    this.characterId = const Value.absent(),
    this.profileName = const Value.absent(),
    this.relationshipState = const Value.absent(),
    this.recentStoryState = const Value.absent(),
    this.emotionalBaseline = const Value.absent(),
    this.openThreads = const Value.absent(),
    this.userProfileSummary = const Value.absent(),
    this.pinnedSummary = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CharacterMemoryProfilesCompanion.insert({
    required String characterId,
    this.profileName = const Value.absent(),
    this.relationshipState = const Value.absent(),
    this.recentStoryState = const Value.absent(),
    this.emotionalBaseline = const Value.absent(),
    this.openThreads = const Value.absent(),
    this.userProfileSummary = const Value.absent(),
    this.pinnedSummary = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : characterId = Value(characterId);
  static Insertable<CharacterMemoryProfile> custom({
    Expression<String>? characterId,
    Expression<String>? profileName,
    Expression<String>? relationshipState,
    Expression<String>? recentStoryState,
    Expression<String>? emotionalBaseline,
    Expression<String>? openThreads,
    Expression<String>? userProfileSummary,
    Expression<String>? pinnedSummary,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (characterId != null) 'character_id': characterId,
      if (profileName != null) 'profile_name': profileName,
      if (relationshipState != null) 'relationship_state': relationshipState,
      if (recentStoryState != null) 'recent_story_state': recentStoryState,
      if (emotionalBaseline != null) 'emotional_baseline': emotionalBaseline,
      if (openThreads != null) 'open_threads': openThreads,
      if (userProfileSummary != null)
        'user_profile_summary': userProfileSummary,
      if (pinnedSummary != null) 'pinned_summary': pinnedSummary,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CharacterMemoryProfilesCompanion copyWith({
    Value<String>? characterId,
    Value<String>? profileName,
    Value<String>? relationshipState,
    Value<String>? recentStoryState,
    Value<String>? emotionalBaseline,
    Value<String>? openThreads,
    Value<String>? userProfileSummary,
    Value<String>? pinnedSummary,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return CharacterMemoryProfilesCompanion(
      characterId: characterId ?? this.characterId,
      profileName: profileName ?? this.profileName,
      relationshipState: relationshipState ?? this.relationshipState,
      recentStoryState: recentStoryState ?? this.recentStoryState,
      emotionalBaseline: emotionalBaseline ?? this.emotionalBaseline,
      openThreads: openThreads ?? this.openThreads,
      userProfileSummary: userProfileSummary ?? this.userProfileSummary,
      pinnedSummary: pinnedSummary ?? this.pinnedSummary,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (profileName.present) {
      map['profile_name'] = Variable<String>(profileName.value);
    }
    if (relationshipState.present) {
      map['relationship_state'] = Variable<String>(relationshipState.value);
    }
    if (recentStoryState.present) {
      map['recent_story_state'] = Variable<String>(recentStoryState.value);
    }
    if (emotionalBaseline.present) {
      map['emotional_baseline'] = Variable<String>(emotionalBaseline.value);
    }
    if (openThreads.present) {
      map['open_threads'] = Variable<String>(openThreads.value);
    }
    if (userProfileSummary.present) {
      map['user_profile_summary'] = Variable<String>(userProfileSummary.value);
    }
    if (pinnedSummary.present) {
      map['pinned_summary'] = Variable<String>(pinnedSummary.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CharacterMemoryProfilesCompanion(')
          ..write('characterId: $characterId, ')
          ..write('profileName: $profileName, ')
          ..write('relationshipState: $relationshipState, ')
          ..write('recentStoryState: $recentStoryState, ')
          ..write('emotionalBaseline: $emotionalBaseline, ')
          ..write('openThreads: $openThreads, ')
          ..write('userProfileSummary: $userProfileSummary, ')
          ..write('pinnedSummary: $pinnedSummary, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CharacterMemoryProfileUpdateTasksTable
    extends CharacterMemoryProfileUpdateTasks
    with
        TableInfo<
          $CharacterMemoryProfileUpdateTasksTable,
          CharacterMemoryProfileUpdateTask
        > {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CharacterMemoryProfileUpdateTasksTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _reasonMeta = const VerificationMeta('reason');
  @override
  late final GeneratedColumn<String> reason = GeneratedColumn<String>(
    'reason',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _patchJsonMeta = const VerificationMeta(
    'patchJson',
  );
  @override
  late final GeneratedColumn<String> patchJson = GeneratedColumn<String>(
    'patch_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('pending'),
  );
  static const VerificationMeta _claimTokenMeta = const VerificationMeta(
    'claimToken',
  );
  @override
  late final GeneratedColumn<String> claimToken = GeneratedColumn<String>(
    'claim_token',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _leaseExpiresAtMeta = const VerificationMeta(
    'leaseExpiresAt',
  );
  @override
  late final GeneratedColumn<int> leaseExpiresAt = GeneratedColumn<int>(
    'lease_expires_at',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _retryCountMeta = const VerificationMeta(
    'retryCount',
  );
  @override
  late final GeneratedColumn<int> retryCount = GeneratedColumn<int>(
    'retry_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _errorMessageMeta = const VerificationMeta(
    'errorMessage',
  );
  @override
  late final GeneratedColumn<String> errorMessage = GeneratedColumn<String>(
    'error_message',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    characterId,
    reason,
    patchJson,
    status,
    claimToken,
    leaseExpiresAt,
    retryCount,
    errorMessage,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'character_memory_profile_update_tasks';
  @override
  VerificationContext validateIntegrity(
    Insertable<CharacterMemoryProfileUpdateTask> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('reason')) {
      context.handle(
        _reasonMeta,
        reason.isAcceptableOrUnknown(data['reason']!, _reasonMeta),
      );
    } else if (isInserting) {
      context.missing(_reasonMeta);
    }
    if (data.containsKey('patch_json')) {
      context.handle(
        _patchJsonMeta,
        patchJson.isAcceptableOrUnknown(data['patch_json']!, _patchJsonMeta),
      );
    } else if (isInserting) {
      context.missing(_patchJsonMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('claim_token')) {
      context.handle(
        _claimTokenMeta,
        claimToken.isAcceptableOrUnknown(data['claim_token']!, _claimTokenMeta),
      );
    }
    if (data.containsKey('lease_expires_at')) {
      context.handle(
        _leaseExpiresAtMeta,
        leaseExpiresAt.isAcceptableOrUnknown(
          data['lease_expires_at']!,
          _leaseExpiresAtMeta,
        ),
      );
    }
    if (data.containsKey('retry_count')) {
      context.handle(
        _retryCountMeta,
        retryCount.isAcceptableOrUnknown(data['retry_count']!, _retryCountMeta),
      );
    }
    if (data.containsKey('error_message')) {
      context.handle(
        _errorMessageMeta,
        errorMessage.isAcceptableOrUnknown(
          data['error_message']!,
          _errorMessageMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  CharacterMemoryProfileUpdateTask map(
    Map<String, dynamic> data, {
    String? tablePrefix,
  }) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CharacterMemoryProfileUpdateTask(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      reason: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reason'],
      )!,
      patchJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}patch_json'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      claimToken: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}claim_token'],
      ),
      leaseExpiresAt: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}lease_expires_at'],
      ),
      retryCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}retry_count'],
      )!,
      errorMessage: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}error_message'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $CharacterMemoryProfileUpdateTasksTable createAlias(String alias) {
    return $CharacterMemoryProfileUpdateTasksTable(attachedDatabase, alias);
  }
}

class CharacterMemoryProfileUpdateTask extends DataClass
    implements Insertable<CharacterMemoryProfileUpdateTask> {
  final int id;
  final String characterId;
  final String reason;
  final String patchJson;
  final String status;
  final String? claimToken;
  final int? leaseExpiresAt;
  final int retryCount;
  final String? errorMessage;
  final DateTime createdAt;
  final DateTime updatedAt;
  const CharacterMemoryProfileUpdateTask({
    required this.id,
    required this.characterId,
    required this.reason,
    required this.patchJson,
    required this.status,
    this.claimToken,
    this.leaseExpiresAt,
    required this.retryCount,
    this.errorMessage,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['character_id'] = Variable<String>(characterId);
    map['reason'] = Variable<String>(reason);
    map['patch_json'] = Variable<String>(patchJson);
    map['status'] = Variable<String>(status);
    if (!nullToAbsent || claimToken != null) {
      map['claim_token'] = Variable<String>(claimToken);
    }
    if (!nullToAbsent || leaseExpiresAt != null) {
      map['lease_expires_at'] = Variable<int>(leaseExpiresAt);
    }
    map['retry_count'] = Variable<int>(retryCount);
    if (!nullToAbsent || errorMessage != null) {
      map['error_message'] = Variable<String>(errorMessage);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  CharacterMemoryProfileUpdateTasksCompanion toCompanion(bool nullToAbsent) {
    return CharacterMemoryProfileUpdateTasksCompanion(
      id: Value(id),
      characterId: Value(characterId),
      reason: Value(reason),
      patchJson: Value(patchJson),
      status: Value(status),
      claimToken: claimToken == null && nullToAbsent
          ? const Value.absent()
          : Value(claimToken),
      leaseExpiresAt: leaseExpiresAt == null && nullToAbsent
          ? const Value.absent()
          : Value(leaseExpiresAt),
      retryCount: Value(retryCount),
      errorMessage: errorMessage == null && nullToAbsent
          ? const Value.absent()
          : Value(errorMessage),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory CharacterMemoryProfileUpdateTask.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CharacterMemoryProfileUpdateTask(
      id: serializer.fromJson<int>(json['id']),
      characterId: serializer.fromJson<String>(json['characterId']),
      reason: serializer.fromJson<String>(json['reason']),
      patchJson: serializer.fromJson<String>(json['patchJson']),
      status: serializer.fromJson<String>(json['status']),
      claimToken: serializer.fromJson<String?>(json['claimToken']),
      leaseExpiresAt: serializer.fromJson<int?>(json['leaseExpiresAt']),
      retryCount: serializer.fromJson<int>(json['retryCount']),
      errorMessage: serializer.fromJson<String?>(json['errorMessage']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'characterId': serializer.toJson<String>(characterId),
      'reason': serializer.toJson<String>(reason),
      'patchJson': serializer.toJson<String>(patchJson),
      'status': serializer.toJson<String>(status),
      'claimToken': serializer.toJson<String?>(claimToken),
      'leaseExpiresAt': serializer.toJson<int?>(leaseExpiresAt),
      'retryCount': serializer.toJson<int>(retryCount),
      'errorMessage': serializer.toJson<String?>(errorMessage),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  CharacterMemoryProfileUpdateTask copyWith({
    int? id,
    String? characterId,
    String? reason,
    String? patchJson,
    String? status,
    Value<String?> claimToken = const Value.absent(),
    Value<int?> leaseExpiresAt = const Value.absent(),
    int? retryCount,
    Value<String?> errorMessage = const Value.absent(),
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => CharacterMemoryProfileUpdateTask(
    id: id ?? this.id,
    characterId: characterId ?? this.characterId,
    reason: reason ?? this.reason,
    patchJson: patchJson ?? this.patchJson,
    status: status ?? this.status,
    claimToken: claimToken.present ? claimToken.value : this.claimToken,
    leaseExpiresAt: leaseExpiresAt.present
        ? leaseExpiresAt.value
        : this.leaseExpiresAt,
    retryCount: retryCount ?? this.retryCount,
    errorMessage: errorMessage.present ? errorMessage.value : this.errorMessage,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  CharacterMemoryProfileUpdateTask copyWithCompanion(
    CharacterMemoryProfileUpdateTasksCompanion data,
  ) {
    return CharacterMemoryProfileUpdateTask(
      id: data.id.present ? data.id.value : this.id,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      reason: data.reason.present ? data.reason.value : this.reason,
      patchJson: data.patchJson.present ? data.patchJson.value : this.patchJson,
      status: data.status.present ? data.status.value : this.status,
      claimToken: data.claimToken.present
          ? data.claimToken.value
          : this.claimToken,
      leaseExpiresAt: data.leaseExpiresAt.present
          ? data.leaseExpiresAt.value
          : this.leaseExpiresAt,
      retryCount: data.retryCount.present
          ? data.retryCount.value
          : this.retryCount,
      errorMessage: data.errorMessage.present
          ? data.errorMessage.value
          : this.errorMessage,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CharacterMemoryProfileUpdateTask(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('reason: $reason, ')
          ..write('patchJson: $patchJson, ')
          ..write('status: $status, ')
          ..write('claimToken: $claimToken, ')
          ..write('leaseExpiresAt: $leaseExpiresAt, ')
          ..write('retryCount: $retryCount, ')
          ..write('errorMessage: $errorMessage, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    characterId,
    reason,
    patchJson,
    status,
    claimToken,
    leaseExpiresAt,
    retryCount,
    errorMessage,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CharacterMemoryProfileUpdateTask &&
          other.id == this.id &&
          other.characterId == this.characterId &&
          other.reason == this.reason &&
          other.patchJson == this.patchJson &&
          other.status == this.status &&
          other.claimToken == this.claimToken &&
          other.leaseExpiresAt == this.leaseExpiresAt &&
          other.retryCount == this.retryCount &&
          other.errorMessage == this.errorMessage &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class CharacterMemoryProfileUpdateTasksCompanion
    extends UpdateCompanion<CharacterMemoryProfileUpdateTask> {
  final Value<int> id;
  final Value<String> characterId;
  final Value<String> reason;
  final Value<String> patchJson;
  final Value<String> status;
  final Value<String?> claimToken;
  final Value<int?> leaseExpiresAt;
  final Value<int> retryCount;
  final Value<String?> errorMessage;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  const CharacterMemoryProfileUpdateTasksCompanion({
    this.id = const Value.absent(),
    this.characterId = const Value.absent(),
    this.reason = const Value.absent(),
    this.patchJson = const Value.absent(),
    this.status = const Value.absent(),
    this.claimToken = const Value.absent(),
    this.leaseExpiresAt = const Value.absent(),
    this.retryCount = const Value.absent(),
    this.errorMessage = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  });
  CharacterMemoryProfileUpdateTasksCompanion.insert({
    this.id = const Value.absent(),
    required String characterId,
    required String reason,
    required String patchJson,
    this.status = const Value.absent(),
    this.claimToken = const Value.absent(),
    this.leaseExpiresAt = const Value.absent(),
    this.retryCount = const Value.absent(),
    this.errorMessage = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  }) : characterId = Value(characterId),
       reason = Value(reason),
       patchJson = Value(patchJson);
  static Insertable<CharacterMemoryProfileUpdateTask> custom({
    Expression<int>? id,
    Expression<String>? characterId,
    Expression<String>? reason,
    Expression<String>? patchJson,
    Expression<String>? status,
    Expression<String>? claimToken,
    Expression<int>? leaseExpiresAt,
    Expression<int>? retryCount,
    Expression<String>? errorMessage,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (characterId != null) 'character_id': characterId,
      if (reason != null) 'reason': reason,
      if (patchJson != null) 'patch_json': patchJson,
      if (status != null) 'status': status,
      if (claimToken != null) 'claim_token': claimToken,
      if (leaseExpiresAt != null) 'lease_expires_at': leaseExpiresAt,
      if (retryCount != null) 'retry_count': retryCount,
      if (errorMessage != null) 'error_message': errorMessage,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
    });
  }

  CharacterMemoryProfileUpdateTasksCompanion copyWith({
    Value<int>? id,
    Value<String>? characterId,
    Value<String>? reason,
    Value<String>? patchJson,
    Value<String>? status,
    Value<String?>? claimToken,
    Value<int?>? leaseExpiresAt,
    Value<int>? retryCount,
    Value<String?>? errorMessage,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
  }) {
    return CharacterMemoryProfileUpdateTasksCompanion(
      id: id ?? this.id,
      characterId: characterId ?? this.characterId,
      reason: reason ?? this.reason,
      patchJson: patchJson ?? this.patchJson,
      status: status ?? this.status,
      claimToken: claimToken ?? this.claimToken,
      leaseExpiresAt: leaseExpiresAt ?? this.leaseExpiresAt,
      retryCount: retryCount ?? this.retryCount,
      errorMessage: errorMessage ?? this.errorMessage,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (reason.present) {
      map['reason'] = Variable<String>(reason.value);
    }
    if (patchJson.present) {
      map['patch_json'] = Variable<String>(patchJson.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (claimToken.present) {
      map['claim_token'] = Variable<String>(claimToken.value);
    }
    if (leaseExpiresAt.present) {
      map['lease_expires_at'] = Variable<int>(leaseExpiresAt.value);
    }
    if (retryCount.present) {
      map['retry_count'] = Variable<int>(retryCount.value);
    }
    if (errorMessage.present) {
      map['error_message'] = Variable<String>(errorMessage.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CharacterMemoryProfileUpdateTasksCompanion(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('reason: $reason, ')
          ..write('patchJson: $patchJson, ')
          ..write('status: $status, ')
          ..write('claimToken: $claimToken, ')
          ..write('leaseExpiresAt: $leaseExpiresAt, ')
          ..write('retryCount: $retryCount, ')
          ..write('errorMessage: $errorMessage, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }
}

class $CharacterMemoryProfileVersionsTable
    extends CharacterMemoryProfileVersions
    with
        TableInfo<
          $CharacterMemoryProfileVersionsTable,
          CharacterMemoryProfileVersion
        > {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CharacterMemoryProfileVersionsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _versionNumberMeta = const VerificationMeta(
    'versionNumber',
  );
  @override
  late final GeneratedColumn<int> versionNumber = GeneratedColumn<int>(
    'version_number',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _snapshotJsonMeta = const VerificationMeta(
    'snapshotJson',
  );
  @override
  late final GeneratedColumn<String> snapshotJson = GeneratedColumn<String>(
    'snapshot_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _reasonMeta = const VerificationMeta('reason');
  @override
  late final GeneratedColumn<String> reason = GeneratedColumn<String>(
    'reason',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _taskIdMeta = const VerificationMeta('taskId');
  @override
  late final GeneratedColumn<int> taskId = GeneratedColumn<int>(
    'task_id',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    characterId,
    versionNumber,
    snapshotJson,
    reason,
    taskId,
    createdAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'character_memory_profile_versions';
  @override
  VerificationContext validateIntegrity(
    Insertable<CharacterMemoryProfileVersion> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('version_number')) {
      context.handle(
        _versionNumberMeta,
        versionNumber.isAcceptableOrUnknown(
          data['version_number']!,
          _versionNumberMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_versionNumberMeta);
    }
    if (data.containsKey('snapshot_json')) {
      context.handle(
        _snapshotJsonMeta,
        snapshotJson.isAcceptableOrUnknown(
          data['snapshot_json']!,
          _snapshotJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_snapshotJsonMeta);
    }
    if (data.containsKey('reason')) {
      context.handle(
        _reasonMeta,
        reason.isAcceptableOrUnknown(data['reason']!, _reasonMeta),
      );
    } else if (isInserting) {
      context.missing(_reasonMeta);
    }
    if (data.containsKey('task_id')) {
      context.handle(
        _taskIdMeta,
        taskId.isAcceptableOrUnknown(data['task_id']!, _taskIdMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  CharacterMemoryProfileVersion map(
    Map<String, dynamic> data, {
    String? tablePrefix,
  }) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CharacterMemoryProfileVersion(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      versionNumber: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}version_number'],
      )!,
      snapshotJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}snapshot_json'],
      )!,
      reason: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reason'],
      )!,
      taskId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}task_id'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
    );
  }

  @override
  $CharacterMemoryProfileVersionsTable createAlias(String alias) {
    return $CharacterMemoryProfileVersionsTable(attachedDatabase, alias);
  }
}

class CharacterMemoryProfileVersion extends DataClass
    implements Insertable<CharacterMemoryProfileVersion> {
  final int id;
  final String characterId;
  final int versionNumber;
  final String snapshotJson;
  final String reason;
  final int? taskId;
  final DateTime createdAt;
  const CharacterMemoryProfileVersion({
    required this.id,
    required this.characterId,
    required this.versionNumber,
    required this.snapshotJson,
    required this.reason,
    this.taskId,
    required this.createdAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['character_id'] = Variable<String>(characterId);
    map['version_number'] = Variable<int>(versionNumber);
    map['snapshot_json'] = Variable<String>(snapshotJson);
    map['reason'] = Variable<String>(reason);
    if (!nullToAbsent || taskId != null) {
      map['task_id'] = Variable<int>(taskId);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    return map;
  }

  CharacterMemoryProfileVersionsCompanion toCompanion(bool nullToAbsent) {
    return CharacterMemoryProfileVersionsCompanion(
      id: Value(id),
      characterId: Value(characterId),
      versionNumber: Value(versionNumber),
      snapshotJson: Value(snapshotJson),
      reason: Value(reason),
      taskId: taskId == null && nullToAbsent
          ? const Value.absent()
          : Value(taskId),
      createdAt: Value(createdAt),
    );
  }

  factory CharacterMemoryProfileVersion.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CharacterMemoryProfileVersion(
      id: serializer.fromJson<int>(json['id']),
      characterId: serializer.fromJson<String>(json['characterId']),
      versionNumber: serializer.fromJson<int>(json['versionNumber']),
      snapshotJson: serializer.fromJson<String>(json['snapshotJson']),
      reason: serializer.fromJson<String>(json['reason']),
      taskId: serializer.fromJson<int?>(json['taskId']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'characterId': serializer.toJson<String>(characterId),
      'versionNumber': serializer.toJson<int>(versionNumber),
      'snapshotJson': serializer.toJson<String>(snapshotJson),
      'reason': serializer.toJson<String>(reason),
      'taskId': serializer.toJson<int?>(taskId),
      'createdAt': serializer.toJson<DateTime>(createdAt),
    };
  }

  CharacterMemoryProfileVersion copyWith({
    int? id,
    String? characterId,
    int? versionNumber,
    String? snapshotJson,
    String? reason,
    Value<int?> taskId = const Value.absent(),
    DateTime? createdAt,
  }) => CharacterMemoryProfileVersion(
    id: id ?? this.id,
    characterId: characterId ?? this.characterId,
    versionNumber: versionNumber ?? this.versionNumber,
    snapshotJson: snapshotJson ?? this.snapshotJson,
    reason: reason ?? this.reason,
    taskId: taskId.present ? taskId.value : this.taskId,
    createdAt: createdAt ?? this.createdAt,
  );
  CharacterMemoryProfileVersion copyWithCompanion(
    CharacterMemoryProfileVersionsCompanion data,
  ) {
    return CharacterMemoryProfileVersion(
      id: data.id.present ? data.id.value : this.id,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      versionNumber: data.versionNumber.present
          ? data.versionNumber.value
          : this.versionNumber,
      snapshotJson: data.snapshotJson.present
          ? data.snapshotJson.value
          : this.snapshotJson,
      reason: data.reason.present ? data.reason.value : this.reason,
      taskId: data.taskId.present ? data.taskId.value : this.taskId,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CharacterMemoryProfileVersion(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('versionNumber: $versionNumber, ')
          ..write('snapshotJson: $snapshotJson, ')
          ..write('reason: $reason, ')
          ..write('taskId: $taskId, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    characterId,
    versionNumber,
    snapshotJson,
    reason,
    taskId,
    createdAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CharacterMemoryProfileVersion &&
          other.id == this.id &&
          other.characterId == this.characterId &&
          other.versionNumber == this.versionNumber &&
          other.snapshotJson == this.snapshotJson &&
          other.reason == this.reason &&
          other.taskId == this.taskId &&
          other.createdAt == this.createdAt);
}

class CharacterMemoryProfileVersionsCompanion
    extends UpdateCompanion<CharacterMemoryProfileVersion> {
  final Value<int> id;
  final Value<String> characterId;
  final Value<int> versionNumber;
  final Value<String> snapshotJson;
  final Value<String> reason;
  final Value<int?> taskId;
  final Value<DateTime> createdAt;
  const CharacterMemoryProfileVersionsCompanion({
    this.id = const Value.absent(),
    this.characterId = const Value.absent(),
    this.versionNumber = const Value.absent(),
    this.snapshotJson = const Value.absent(),
    this.reason = const Value.absent(),
    this.taskId = const Value.absent(),
    this.createdAt = const Value.absent(),
  });
  CharacterMemoryProfileVersionsCompanion.insert({
    this.id = const Value.absent(),
    required String characterId,
    required int versionNumber,
    required String snapshotJson,
    required String reason,
    this.taskId = const Value.absent(),
    this.createdAt = const Value.absent(),
  }) : characterId = Value(characterId),
       versionNumber = Value(versionNumber),
       snapshotJson = Value(snapshotJson),
       reason = Value(reason);
  static Insertable<CharacterMemoryProfileVersion> custom({
    Expression<int>? id,
    Expression<String>? characterId,
    Expression<int>? versionNumber,
    Expression<String>? snapshotJson,
    Expression<String>? reason,
    Expression<int>? taskId,
    Expression<DateTime>? createdAt,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (characterId != null) 'character_id': characterId,
      if (versionNumber != null) 'version_number': versionNumber,
      if (snapshotJson != null) 'snapshot_json': snapshotJson,
      if (reason != null) 'reason': reason,
      if (taskId != null) 'task_id': taskId,
      if (createdAt != null) 'created_at': createdAt,
    });
  }

  CharacterMemoryProfileVersionsCompanion copyWith({
    Value<int>? id,
    Value<String>? characterId,
    Value<int>? versionNumber,
    Value<String>? snapshotJson,
    Value<String>? reason,
    Value<int?>? taskId,
    Value<DateTime>? createdAt,
  }) {
    return CharacterMemoryProfileVersionsCompanion(
      id: id ?? this.id,
      characterId: characterId ?? this.characterId,
      versionNumber: versionNumber ?? this.versionNumber,
      snapshotJson: snapshotJson ?? this.snapshotJson,
      reason: reason ?? this.reason,
      taskId: taskId ?? this.taskId,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (versionNumber.present) {
      map['version_number'] = Variable<int>(versionNumber.value);
    }
    if (snapshotJson.present) {
      map['snapshot_json'] = Variable<String>(snapshotJson.value);
    }
    if (reason.present) {
      map['reason'] = Variable<String>(reason.value);
    }
    if (taskId.present) {
      map['task_id'] = Variable<int>(taskId.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CharacterMemoryProfileVersionsCompanion(')
          ..write('id: $id, ')
          ..write('characterId: $characterId, ')
          ..write('versionNumber: $versionNumber, ')
          ..write('snapshotJson: $snapshotJson, ')
          ..write('reason: $reason, ')
          ..write('taskId: $taskId, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }
}

class $MemoryExtractionCandidatesTable extends MemoryExtractionCandidates
    with
        TableInfo<$MemoryExtractionCandidatesTable, MemoryExtractionCandidate> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MemoryExtractionCandidatesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    hasAutoIncrement: true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'PRIMARY KEY AUTOINCREMENT',
    ),
  );
  static const VerificationMeta _taskIdMeta = const VerificationMeta('taskId');
  @override
  late final GeneratedColumn<int> taskId = GeneratedColumn<int>(
    'task_id',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _characterIdMeta = const VerificationMeta(
    'characterId',
  );
  @override
  late final GeneratedColumn<String> characterId = GeneratedColumn<String>(
    'character_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES characters (id) ON DELETE CASCADE',
    ),
  );
  static const VerificationMeta _conversationIdMeta = const VerificationMeta(
    'conversationId',
  );
  @override
  late final GeneratedColumn<String> conversationId = GeneratedColumn<String>(
    'conversation_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _rawCandidateJsonMeta = const VerificationMeta(
    'rawCandidateJson',
  );
  @override
  late final GeneratedColumn<String> rawCandidateJson = GeneratedColumn<String>(
    'raw_candidate_json',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _rawResponseMeta = const VerificationMeta(
    'rawResponse',
  );
  @override
  late final GeneratedColumn<String> rawResponse = GeneratedColumn<String>(
    'raw_response',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _errorReasonMeta = const VerificationMeta(
    'errorReason',
  );
  @override
  late final GeneratedColumn<String> errorReason = GeneratedColumn<String>(
    'error_reason',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    taskId,
    characterId,
    conversationId,
    rawCandidateJson,
    rawResponse,
    status,
    errorReason,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'memory_extraction_candidates';
  @override
  VerificationContext validateIntegrity(
    Insertable<MemoryExtractionCandidate> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('task_id')) {
      context.handle(
        _taskIdMeta,
        taskId.isAcceptableOrUnknown(data['task_id']!, _taskIdMeta),
      );
    }
    if (data.containsKey('character_id')) {
      context.handle(
        _characterIdMeta,
        characterId.isAcceptableOrUnknown(
          data['character_id']!,
          _characterIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_characterIdMeta);
    }
    if (data.containsKey('conversation_id')) {
      context.handle(
        _conversationIdMeta,
        conversationId.isAcceptableOrUnknown(
          data['conversation_id']!,
          _conversationIdMeta,
        ),
      );
    }
    if (data.containsKey('raw_candidate_json')) {
      context.handle(
        _rawCandidateJsonMeta,
        rawCandidateJson.isAcceptableOrUnknown(
          data['raw_candidate_json']!,
          _rawCandidateJsonMeta,
        ),
      );
    }
    if (data.containsKey('raw_response')) {
      context.handle(
        _rawResponseMeta,
        rawResponse.isAcceptableOrUnknown(
          data['raw_response']!,
          _rawResponseMeta,
        ),
      );
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    } else if (isInserting) {
      context.missing(_statusMeta);
    }
    if (data.containsKey('error_reason')) {
      context.handle(
        _errorReasonMeta,
        errorReason.isAcceptableOrUnknown(
          data['error_reason']!,
          _errorReasonMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  MemoryExtractionCandidate map(
    Map<String, dynamic> data, {
    String? tablePrefix,
  }) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return MemoryExtractionCandidate(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      taskId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}task_id'],
      ),
      characterId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}character_id'],
      )!,
      conversationId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}conversation_id'],
      ),
      rawCandidateJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}raw_candidate_json'],
      ),
      rawResponse: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}raw_response'],
      ),
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      errorReason: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}error_reason'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $MemoryExtractionCandidatesTable createAlias(String alias) {
    return $MemoryExtractionCandidatesTable(attachedDatabase, alias);
  }
}

class MemoryExtractionCandidate extends DataClass
    implements Insertable<MemoryExtractionCandidate> {
  final int id;
  final int? taskId;
  final String characterId;
  final String? conversationId;
  final String? rawCandidateJson;
  final String? rawResponse;
  final String status;
  final String? errorReason;
  final DateTime createdAt;
  final DateTime updatedAt;
  const MemoryExtractionCandidate({
    required this.id,
    this.taskId,
    required this.characterId,
    this.conversationId,
    this.rawCandidateJson,
    this.rawResponse,
    required this.status,
    this.errorReason,
    required this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    if (!nullToAbsent || taskId != null) {
      map['task_id'] = Variable<int>(taskId);
    }
    map['character_id'] = Variable<String>(characterId);
    if (!nullToAbsent || conversationId != null) {
      map['conversation_id'] = Variable<String>(conversationId);
    }
    if (!nullToAbsent || rawCandidateJson != null) {
      map['raw_candidate_json'] = Variable<String>(rawCandidateJson);
    }
    if (!nullToAbsent || rawResponse != null) {
      map['raw_response'] = Variable<String>(rawResponse);
    }
    map['status'] = Variable<String>(status);
    if (!nullToAbsent || errorReason != null) {
      map['error_reason'] = Variable<String>(errorReason);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  MemoryExtractionCandidatesCompanion toCompanion(bool nullToAbsent) {
    return MemoryExtractionCandidatesCompanion(
      id: Value(id),
      taskId: taskId == null && nullToAbsent
          ? const Value.absent()
          : Value(taskId),
      characterId: Value(characterId),
      conversationId: conversationId == null && nullToAbsent
          ? const Value.absent()
          : Value(conversationId),
      rawCandidateJson: rawCandidateJson == null && nullToAbsent
          ? const Value.absent()
          : Value(rawCandidateJson),
      rawResponse: rawResponse == null && nullToAbsent
          ? const Value.absent()
          : Value(rawResponse),
      status: Value(status),
      errorReason: errorReason == null && nullToAbsent
          ? const Value.absent()
          : Value(errorReason),
      createdAt: Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory MemoryExtractionCandidate.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return MemoryExtractionCandidate(
      id: serializer.fromJson<int>(json['id']),
      taskId: serializer.fromJson<int?>(json['taskId']),
      characterId: serializer.fromJson<String>(json['characterId']),
      conversationId: serializer.fromJson<String?>(json['conversationId']),
      rawCandidateJson: serializer.fromJson<String?>(json['rawCandidateJson']),
      rawResponse: serializer.fromJson<String?>(json['rawResponse']),
      status: serializer.fromJson<String>(json['status']),
      errorReason: serializer.fromJson<String?>(json['errorReason']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'taskId': serializer.toJson<int?>(taskId),
      'characterId': serializer.toJson<String>(characterId),
      'conversationId': serializer.toJson<String?>(conversationId),
      'rawCandidateJson': serializer.toJson<String?>(rawCandidateJson),
      'rawResponse': serializer.toJson<String?>(rawResponse),
      'status': serializer.toJson<String>(status),
      'errorReason': serializer.toJson<String?>(errorReason),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  MemoryExtractionCandidate copyWith({
    int? id,
    Value<int?> taskId = const Value.absent(),
    String? characterId,
    Value<String?> conversationId = const Value.absent(),
    Value<String?> rawCandidateJson = const Value.absent(),
    Value<String?> rawResponse = const Value.absent(),
    String? status,
    Value<String?> errorReason = const Value.absent(),
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => MemoryExtractionCandidate(
    id: id ?? this.id,
    taskId: taskId.present ? taskId.value : this.taskId,
    characterId: characterId ?? this.characterId,
    conversationId: conversationId.present
        ? conversationId.value
        : this.conversationId,
    rawCandidateJson: rawCandidateJson.present
        ? rawCandidateJson.value
        : this.rawCandidateJson,
    rawResponse: rawResponse.present ? rawResponse.value : this.rawResponse,
    status: status ?? this.status,
    errorReason: errorReason.present ? errorReason.value : this.errorReason,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  MemoryExtractionCandidate copyWithCompanion(
    MemoryExtractionCandidatesCompanion data,
  ) {
    return MemoryExtractionCandidate(
      id: data.id.present ? data.id.value : this.id,
      taskId: data.taskId.present ? data.taskId.value : this.taskId,
      characterId: data.characterId.present
          ? data.characterId.value
          : this.characterId,
      conversationId: data.conversationId.present
          ? data.conversationId.value
          : this.conversationId,
      rawCandidateJson: data.rawCandidateJson.present
          ? data.rawCandidateJson.value
          : this.rawCandidateJson,
      rawResponse: data.rawResponse.present
          ? data.rawResponse.value
          : this.rawResponse,
      status: data.status.present ? data.status.value : this.status,
      errorReason: data.errorReason.present
          ? data.errorReason.value
          : this.errorReason,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MemoryExtractionCandidate(')
          ..write('id: $id, ')
          ..write('taskId: $taskId, ')
          ..write('characterId: $characterId, ')
          ..write('conversationId: $conversationId, ')
          ..write('rawCandidateJson: $rawCandidateJson, ')
          ..write('rawResponse: $rawResponse, ')
          ..write('status: $status, ')
          ..write('errorReason: $errorReason, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    taskId,
    characterId,
    conversationId,
    rawCandidateJson,
    rawResponse,
    status,
    errorReason,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MemoryExtractionCandidate &&
          other.id == this.id &&
          other.taskId == this.taskId &&
          other.characterId == this.characterId &&
          other.conversationId == this.conversationId &&
          other.rawCandidateJson == this.rawCandidateJson &&
          other.rawResponse == this.rawResponse &&
          other.status == this.status &&
          other.errorReason == this.errorReason &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class MemoryExtractionCandidatesCompanion
    extends UpdateCompanion<MemoryExtractionCandidate> {
  final Value<int> id;
  final Value<int?> taskId;
  final Value<String> characterId;
  final Value<String?> conversationId;
  final Value<String?> rawCandidateJson;
  final Value<String?> rawResponse;
  final Value<String> status;
  final Value<String?> errorReason;
  final Value<DateTime> createdAt;
  final Value<DateTime> updatedAt;
  const MemoryExtractionCandidatesCompanion({
    this.id = const Value.absent(),
    this.taskId = const Value.absent(),
    this.characterId = const Value.absent(),
    this.conversationId = const Value.absent(),
    this.rawCandidateJson = const Value.absent(),
    this.rawResponse = const Value.absent(),
    this.status = const Value.absent(),
    this.errorReason = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  });
  MemoryExtractionCandidatesCompanion.insert({
    this.id = const Value.absent(),
    this.taskId = const Value.absent(),
    required String characterId,
    this.conversationId = const Value.absent(),
    this.rawCandidateJson = const Value.absent(),
    this.rawResponse = const Value.absent(),
    required String status,
    this.errorReason = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
  }) : characterId = Value(characterId),
       status = Value(status);
  static Insertable<MemoryExtractionCandidate> custom({
    Expression<int>? id,
    Expression<int>? taskId,
    Expression<String>? characterId,
    Expression<String>? conversationId,
    Expression<String>? rawCandidateJson,
    Expression<String>? rawResponse,
    Expression<String>? status,
    Expression<String>? errorReason,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? updatedAt,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (taskId != null) 'task_id': taskId,
      if (characterId != null) 'character_id': characterId,
      if (conversationId != null) 'conversation_id': conversationId,
      if (rawCandidateJson != null) 'raw_candidate_json': rawCandidateJson,
      if (rawResponse != null) 'raw_response': rawResponse,
      if (status != null) 'status': status,
      if (errorReason != null) 'error_reason': errorReason,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
    });
  }

  MemoryExtractionCandidatesCompanion copyWith({
    Value<int>? id,
    Value<int?>? taskId,
    Value<String>? characterId,
    Value<String?>? conversationId,
    Value<String?>? rawCandidateJson,
    Value<String?>? rawResponse,
    Value<String>? status,
    Value<String?>? errorReason,
    Value<DateTime>? createdAt,
    Value<DateTime>? updatedAt,
  }) {
    return MemoryExtractionCandidatesCompanion(
      id: id ?? this.id,
      taskId: taskId ?? this.taskId,
      characterId: characterId ?? this.characterId,
      conversationId: conversationId ?? this.conversationId,
      rawCandidateJson: rawCandidateJson ?? this.rawCandidateJson,
      rawResponse: rawResponse ?? this.rawResponse,
      status: status ?? this.status,
      errorReason: errorReason ?? this.errorReason,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (taskId.present) {
      map['task_id'] = Variable<int>(taskId.value);
    }
    if (characterId.present) {
      map['character_id'] = Variable<String>(characterId.value);
    }
    if (conversationId.present) {
      map['conversation_id'] = Variable<String>(conversationId.value);
    }
    if (rawCandidateJson.present) {
      map['raw_candidate_json'] = Variable<String>(rawCandidateJson.value);
    }
    if (rawResponse.present) {
      map['raw_response'] = Variable<String>(rawResponse.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (errorReason.present) {
      map['error_reason'] = Variable<String>(errorReason.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MemoryExtractionCandidatesCompanion(')
          ..write('id: $id, ')
          ..write('taskId: $taskId, ')
          ..write('characterId: $characterId, ')
          ..write('conversationId: $conversationId, ')
          ..write('rawCandidateJson: $rawCandidateJson, ')
          ..write('rawResponse: $rawResponse, ')
          ..write('status: $status, ')
          ..write('errorReason: $errorReason, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }
}

abstract class _$AppDatabase extends GeneratedDatabase {
  _$AppDatabase(QueryExecutor e) : super(e);
  $AppDatabaseManager get managers => $AppDatabaseManager(this);
  late final $CharactersTable characters = $CharactersTable(this);
  late final $ConversationsTable conversations = $ConversationsTable(this);
  late final $MessagesTable messages = $MessagesTable(this);
  late final $MemoriesTable memories = $MemoriesTable(this);
  late final $SettingsTable settings = $SettingsTable(this);
  late final $MemoryTasksTable memoryTasks = $MemoryTasksTable(this);
  late final $ModelCacheTable modelCache = $ModelCacheTable(this);
  late final $ApiProvidersTable apiProviders = $ApiProvidersTable(this);
  late final $MemoryEmbeddingsTable memoryEmbeddings = $MemoryEmbeddingsTable(
    this,
  );
  late final $MemoryEmbeddingTasksTable memoryEmbeddingTasks =
      $MemoryEmbeddingTasksTable(this);
  late final $CharacterMemoryProfilesTable characterMemoryProfiles =
      $CharacterMemoryProfilesTable(this);
  late final $CharacterMemoryProfileUpdateTasksTable
  characterMemoryProfileUpdateTasks = $CharacterMemoryProfileUpdateTasksTable(
    this,
  );
  late final $CharacterMemoryProfileVersionsTable
  characterMemoryProfileVersions = $CharacterMemoryProfileVersionsTable(this);
  late final $MemoryExtractionCandidatesTable memoryExtractionCandidates =
      $MemoryExtractionCandidatesTable(this);
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    characters,
    conversations,
    messages,
    memories,
    settings,
    memoryTasks,
    modelCache,
    apiProviders,
    memoryEmbeddings,
    memoryEmbeddingTasks,
    characterMemoryProfiles,
    characterMemoryProfileUpdateTasks,
    characterMemoryProfileVersions,
    memoryExtractionCandidates,
  ];
  @override
  StreamQueryUpdateRules get streamUpdateRules => const StreamQueryUpdateRules([
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('conversations', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'conversations',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('messages', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('memories', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('memory_tasks', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'conversations',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('memory_tasks', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'memories',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('memory_embeddings', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('memory_embeddings', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'memories',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('memory_embedding_tasks', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [TableUpdate('memory_embedding_tasks', kind: UpdateKind.delete)],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [
        TableUpdate('character_memory_profiles', kind: UpdateKind.delete),
      ],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [
        TableUpdate(
          'character_memory_profile_update_tasks',
          kind: UpdateKind.delete,
        ),
      ],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [
        TableUpdate(
          'character_memory_profile_versions',
          kind: UpdateKind.delete,
        ),
      ],
    ),
    WritePropagation(
      on: TableUpdateQuery.onTableName(
        'characters',
        limitUpdateKind: UpdateKind.delete,
      ),
      result: [
        TableUpdate('memory_extraction_candidates', kind: UpdateKind.delete),
      ],
    ),
  ]);
}

typedef $$CharactersTableCreateCompanionBuilder =
    CharactersCompanion Function({
      required String id,
      Value<String> name,
      Value<String?> avatarUrl,
      Value<String> personality,
      Value<String> scenario,
      Value<String> greeting,
      Value<String> exampleDialogue,
      Value<String> systemPrompt,
      Value<String> basicInfo,
      Value<String> otherInfo,
      Value<String> imageTags,
      Value<String> userImageTags,
      Value<int> sortOrder,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });
typedef $$CharactersTableUpdateCompanionBuilder =
    CharactersCompanion Function({
      Value<String> id,
      Value<String> name,
      Value<String?> avatarUrl,
      Value<String> personality,
      Value<String> scenario,
      Value<String> greeting,
      Value<String> exampleDialogue,
      Value<String> systemPrompt,
      Value<String> basicInfo,
      Value<String> otherInfo,
      Value<String> imageTags,
      Value<String> userImageTags,
      Value<int> sortOrder,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

final class $$CharactersTableReferences
    extends BaseReferences<_$AppDatabase, $CharactersTable, Character> {
  $$CharactersTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static MultiTypedResultKey<$ConversationsTable, List<Conversation>>
  _conversationsRefsTable(_$AppDatabase db) => MultiTypedResultKey.fromTable(
    db.conversations,
    aliasName: $_aliasNameGenerator(
      db.characters.id,
      db.conversations.characterId,
    ),
  );

  $$ConversationsTableProcessedTableManager get conversationsRefs {
    final manager = $$ConversationsTableTableManager(
      $_db,
      $_db.conversations,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_conversationsRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<$MemoriesTable, List<Memory>> _memoriesRefsTable(
    _$AppDatabase db,
  ) => MultiTypedResultKey.fromTable(
    db.memories,
    aliasName: $_aliasNameGenerator(db.characters.id, db.memories.characterId),
  );

  $$MemoriesTableProcessedTableManager get memoriesRefs {
    final manager = $$MemoriesTableTableManager(
      $_db,
      $_db.memories,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_memoriesRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<$MemoryTasksTable, List<MemoryTask>>
  _memoryTasksRefsTable(_$AppDatabase db) => MultiTypedResultKey.fromTable(
    db.memoryTasks,
    aliasName: $_aliasNameGenerator(
      db.characters.id,
      db.memoryTasks.characterId,
    ),
  );

  $$MemoryTasksTableProcessedTableManager get memoryTasksRefs {
    final manager = $$MemoryTasksTableTableManager(
      $_db,
      $_db.memoryTasks,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_memoryTasksRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<$MemoryEmbeddingsTable, List<MemoryEmbedding>>
  _memoryEmbeddingsRefsTable(_$AppDatabase db) => MultiTypedResultKey.fromTable(
    db.memoryEmbeddings,
    aliasName: $_aliasNameGenerator(
      db.characters.id,
      db.memoryEmbeddings.characterId,
    ),
  );

  $$MemoryEmbeddingsTableProcessedTableManager get memoryEmbeddingsRefs {
    final manager = $$MemoryEmbeddingsTableTableManager(
      $_db,
      $_db.memoryEmbeddings,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _memoryEmbeddingsRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<
    $MemoryEmbeddingTasksTable,
    List<MemoryEmbeddingTask>
  >
  _memoryEmbeddingTasksRefsTable(_$AppDatabase db) =>
      MultiTypedResultKey.fromTable(
        db.memoryEmbeddingTasks,
        aliasName: $_aliasNameGenerator(
          db.characters.id,
          db.memoryEmbeddingTasks.characterId,
        ),
      );

  $$MemoryEmbeddingTasksTableProcessedTableManager
  get memoryEmbeddingTasksRefs {
    final manager = $$MemoryEmbeddingTasksTableTableManager(
      $_db,
      $_db.memoryEmbeddingTasks,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _memoryEmbeddingTasksRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<
    $CharacterMemoryProfilesTable,
    List<CharacterMemoryProfile>
  >
  _characterMemoryProfilesRefsTable(_$AppDatabase db) =>
      MultiTypedResultKey.fromTable(
        db.characterMemoryProfiles,
        aliasName: $_aliasNameGenerator(
          db.characters.id,
          db.characterMemoryProfiles.characterId,
        ),
      );

  $$CharacterMemoryProfilesTableProcessedTableManager
  get characterMemoryProfilesRefs {
    final manager = $$CharacterMemoryProfilesTableTableManager(
      $_db,
      $_db.characterMemoryProfiles,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _characterMemoryProfilesRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<
    $CharacterMemoryProfileUpdateTasksTable,
    List<CharacterMemoryProfileUpdateTask>
  >
  _characterMemoryProfileUpdateTasksRefsTable(_$AppDatabase db) =>
      MultiTypedResultKey.fromTable(
        db.characterMemoryProfileUpdateTasks,
        aliasName: $_aliasNameGenerator(
          db.characters.id,
          db.characterMemoryProfileUpdateTasks.characterId,
        ),
      );

  $$CharacterMemoryProfileUpdateTasksTableProcessedTableManager
  get characterMemoryProfileUpdateTasksRefs {
    final manager = $$CharacterMemoryProfileUpdateTasksTableTableManager(
      $_db,
      $_db.characterMemoryProfileUpdateTasks,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _characterMemoryProfileUpdateTasksRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<
    $CharacterMemoryProfileVersionsTable,
    List<CharacterMemoryProfileVersion>
  >
  _characterMemoryProfileVersionsRefsTable(_$AppDatabase db) =>
      MultiTypedResultKey.fromTable(
        db.characterMemoryProfileVersions,
        aliasName: $_aliasNameGenerator(
          db.characters.id,
          db.characterMemoryProfileVersions.characterId,
        ),
      );

  $$CharacterMemoryProfileVersionsTableProcessedTableManager
  get characterMemoryProfileVersionsRefs {
    final manager = $$CharacterMemoryProfileVersionsTableTableManager(
      $_db,
      $_db.characterMemoryProfileVersions,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _characterMemoryProfileVersionsRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<
    $MemoryExtractionCandidatesTable,
    List<MemoryExtractionCandidate>
  >
  _memoryExtractionCandidatesRefsTable(_$AppDatabase db) =>
      MultiTypedResultKey.fromTable(
        db.memoryExtractionCandidates,
        aliasName: $_aliasNameGenerator(
          db.characters.id,
          db.memoryExtractionCandidates.characterId,
        ),
      );

  $$MemoryExtractionCandidatesTableProcessedTableManager
  get memoryExtractionCandidatesRefs {
    final manager = $$MemoryExtractionCandidatesTableTableManager(
      $_db,
      $_db.memoryExtractionCandidates,
    ).filter((f) => f.characterId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _memoryExtractionCandidatesRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }
}

class $$CharactersTableFilterComposer
    extends Composer<_$AppDatabase, $CharactersTable> {
  $$CharactersTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get avatarUrl => $composableBuilder(
    column: $table.avatarUrl,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get personality => $composableBuilder(
    column: $table.personality,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get scenario => $composableBuilder(
    column: $table.scenario,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get greeting => $composableBuilder(
    column: $table.greeting,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get exampleDialogue => $composableBuilder(
    column: $table.exampleDialogue,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get systemPrompt => $composableBuilder(
    column: $table.systemPrompt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get basicInfo => $composableBuilder(
    column: $table.basicInfo,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get otherInfo => $composableBuilder(
    column: $table.otherInfo,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imageTags => $composableBuilder(
    column: $table.imageTags,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get userImageTags => $composableBuilder(
    column: $table.userImageTags,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get sortOrder => $composableBuilder(
    column: $table.sortOrder,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  Expression<bool> conversationsRefs(
    Expression<bool> Function($$ConversationsTableFilterComposer f) f,
  ) {
    final $$ConversationsTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableFilterComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> memoriesRefs(
    Expression<bool> Function($$MemoriesTableFilterComposer f) f,
  ) {
    final $$MemoriesTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableFilterComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> memoryTasksRefs(
    Expression<bool> Function($$MemoryTasksTableFilterComposer f) f,
  ) {
    final $$MemoryTasksTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryTasks,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryTasksTableFilterComposer(
            $db: $db,
            $table: $db.memoryTasks,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> memoryEmbeddingsRefs(
    Expression<bool> Function($$MemoryEmbeddingsTableFilterComposer f) f,
  ) {
    final $$MemoryEmbeddingsTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryEmbeddings,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryEmbeddingsTableFilterComposer(
            $db: $db,
            $table: $db.memoryEmbeddings,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> memoryEmbeddingTasksRefs(
    Expression<bool> Function($$MemoryEmbeddingTasksTableFilterComposer f) f,
  ) {
    final $$MemoryEmbeddingTasksTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryEmbeddingTasks,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryEmbeddingTasksTableFilterComposer(
            $db: $db,
            $table: $db.memoryEmbeddingTasks,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> characterMemoryProfilesRefs(
    Expression<bool> Function($$CharacterMemoryProfilesTableFilterComposer f) f,
  ) {
    final $$CharacterMemoryProfilesTableFilterComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.characterMemoryProfiles,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$CharacterMemoryProfilesTableFilterComposer(
                $db: $db,
                $table: $db.characterMemoryProfiles,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }

  Expression<bool> characterMemoryProfileUpdateTasksRefs(
    Expression<bool> Function(
      $$CharacterMemoryProfileUpdateTasksTableFilterComposer f,
    )
    f,
  ) {
    final $$CharacterMemoryProfileUpdateTasksTableFilterComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.characterMemoryProfileUpdateTasks,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$CharacterMemoryProfileUpdateTasksTableFilterComposer(
                $db: $db,
                $table: $db.characterMemoryProfileUpdateTasks,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }

  Expression<bool> characterMemoryProfileVersionsRefs(
    Expression<bool> Function(
      $$CharacterMemoryProfileVersionsTableFilterComposer f,
    )
    f,
  ) {
    final $$CharacterMemoryProfileVersionsTableFilterComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.characterMemoryProfileVersions,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$CharacterMemoryProfileVersionsTableFilterComposer(
                $db: $db,
                $table: $db.characterMemoryProfileVersions,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }

  Expression<bool> memoryExtractionCandidatesRefs(
    Expression<bool> Function($$MemoryExtractionCandidatesTableFilterComposer f)
    f,
  ) {
    final $$MemoryExtractionCandidatesTableFilterComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.memoryExtractionCandidates,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$MemoryExtractionCandidatesTableFilterComposer(
                $db: $db,
                $table: $db.memoryExtractionCandidates,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }
}

class $$CharactersTableOrderingComposer
    extends Composer<_$AppDatabase, $CharactersTable> {
  $$CharactersTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get avatarUrl => $composableBuilder(
    column: $table.avatarUrl,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get personality => $composableBuilder(
    column: $table.personality,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get scenario => $composableBuilder(
    column: $table.scenario,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get greeting => $composableBuilder(
    column: $table.greeting,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get exampleDialogue => $composableBuilder(
    column: $table.exampleDialogue,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get systemPrompt => $composableBuilder(
    column: $table.systemPrompt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get basicInfo => $composableBuilder(
    column: $table.basicInfo,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get otherInfo => $composableBuilder(
    column: $table.otherInfo,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imageTags => $composableBuilder(
    column: $table.imageTags,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get userImageTags => $composableBuilder(
    column: $table.userImageTags,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get sortOrder => $composableBuilder(
    column: $table.sortOrder,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CharactersTableAnnotationComposer
    extends Composer<_$AppDatabase, $CharactersTable> {
  $$CharactersTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get avatarUrl =>
      $composableBuilder(column: $table.avatarUrl, builder: (column) => column);

  GeneratedColumn<String> get personality => $composableBuilder(
    column: $table.personality,
    builder: (column) => column,
  );

  GeneratedColumn<String> get scenario =>
      $composableBuilder(column: $table.scenario, builder: (column) => column);

  GeneratedColumn<String> get greeting =>
      $composableBuilder(column: $table.greeting, builder: (column) => column);

  GeneratedColumn<String> get exampleDialogue => $composableBuilder(
    column: $table.exampleDialogue,
    builder: (column) => column,
  );

  GeneratedColumn<String> get systemPrompt => $composableBuilder(
    column: $table.systemPrompt,
    builder: (column) => column,
  );

  GeneratedColumn<String> get basicInfo =>
      $composableBuilder(column: $table.basicInfo, builder: (column) => column);

  GeneratedColumn<String> get otherInfo =>
      $composableBuilder(column: $table.otherInfo, builder: (column) => column);

  GeneratedColumn<String> get imageTags =>
      $composableBuilder(column: $table.imageTags, builder: (column) => column);

  GeneratedColumn<String> get userImageTags => $composableBuilder(
    column: $table.userImageTags,
    builder: (column) => column,
  );

  GeneratedColumn<int> get sortOrder =>
      $composableBuilder(column: $table.sortOrder, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  Expression<T> conversationsRefs<T extends Object>(
    Expression<T> Function($$ConversationsTableAnnotationComposer a) f,
  ) {
    final $$ConversationsTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableAnnotationComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<T> memoriesRefs<T extends Object>(
    Expression<T> Function($$MemoriesTableAnnotationComposer a) f,
  ) {
    final $$MemoriesTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableAnnotationComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<T> memoryTasksRefs<T extends Object>(
    Expression<T> Function($$MemoryTasksTableAnnotationComposer a) f,
  ) {
    final $$MemoryTasksTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryTasks,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryTasksTableAnnotationComposer(
            $db: $db,
            $table: $db.memoryTasks,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<T> memoryEmbeddingsRefs<T extends Object>(
    Expression<T> Function($$MemoryEmbeddingsTableAnnotationComposer a) f,
  ) {
    final $$MemoryEmbeddingsTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryEmbeddings,
      getReferencedColumn: (t) => t.characterId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryEmbeddingsTableAnnotationComposer(
            $db: $db,
            $table: $db.memoryEmbeddings,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<T> memoryEmbeddingTasksRefs<T extends Object>(
    Expression<T> Function($$MemoryEmbeddingTasksTableAnnotationComposer a) f,
  ) {
    final $$MemoryEmbeddingTasksTableAnnotationComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.memoryEmbeddingTasks,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$MemoryEmbeddingTasksTableAnnotationComposer(
                $db: $db,
                $table: $db.memoryEmbeddingTasks,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }

  Expression<T> characterMemoryProfilesRefs<T extends Object>(
    Expression<T> Function($$CharacterMemoryProfilesTableAnnotationComposer a)
    f,
  ) {
    final $$CharacterMemoryProfilesTableAnnotationComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.characterMemoryProfiles,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$CharacterMemoryProfilesTableAnnotationComposer(
                $db: $db,
                $table: $db.characterMemoryProfiles,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }

  Expression<T> characterMemoryProfileUpdateTasksRefs<T extends Object>(
    Expression<T> Function(
      $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer a,
    )
    f,
  ) {
    final $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.characterMemoryProfileUpdateTasks,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer(
                $db: $db,
                $table: $db.characterMemoryProfileUpdateTasks,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }

  Expression<T> characterMemoryProfileVersionsRefs<T extends Object>(
    Expression<T> Function(
      $$CharacterMemoryProfileVersionsTableAnnotationComposer a,
    )
    f,
  ) {
    final $$CharacterMemoryProfileVersionsTableAnnotationComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.characterMemoryProfileVersions,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$CharacterMemoryProfileVersionsTableAnnotationComposer(
                $db: $db,
                $table: $db.characterMemoryProfileVersions,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }

  Expression<T> memoryExtractionCandidatesRefs<T extends Object>(
    Expression<T> Function(
      $$MemoryExtractionCandidatesTableAnnotationComposer a,
    )
    f,
  ) {
    final $$MemoryExtractionCandidatesTableAnnotationComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.memoryExtractionCandidates,
          getReferencedColumn: (t) => t.characterId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$MemoryExtractionCandidatesTableAnnotationComposer(
                $db: $db,
                $table: $db.memoryExtractionCandidates,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }
}

class $$CharactersTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CharactersTable,
          Character,
          $$CharactersTableFilterComposer,
          $$CharactersTableOrderingComposer,
          $$CharactersTableAnnotationComposer,
          $$CharactersTableCreateCompanionBuilder,
          $$CharactersTableUpdateCompanionBuilder,
          (Character, $$CharactersTableReferences),
          Character,
          PrefetchHooks Function({
            bool conversationsRefs,
            bool memoriesRefs,
            bool memoryTasksRefs,
            bool memoryEmbeddingsRefs,
            bool memoryEmbeddingTasksRefs,
            bool characterMemoryProfilesRefs,
            bool characterMemoryProfileUpdateTasksRefs,
            bool characterMemoryProfileVersionsRefs,
            bool memoryExtractionCandidatesRefs,
          })
        > {
  $$CharactersTableTableManager(_$AppDatabase db, $CharactersTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CharactersTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CharactersTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CharactersTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String?> avatarUrl = const Value.absent(),
                Value<String> personality = const Value.absent(),
                Value<String> scenario = const Value.absent(),
                Value<String> greeting = const Value.absent(),
                Value<String> exampleDialogue = const Value.absent(),
                Value<String> systemPrompt = const Value.absent(),
                Value<String> basicInfo = const Value.absent(),
                Value<String> otherInfo = const Value.absent(),
                Value<String> imageTags = const Value.absent(),
                Value<String> userImageTags = const Value.absent(),
                Value<int> sortOrder = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CharactersCompanion(
                id: id,
                name: name,
                avatarUrl: avatarUrl,
                personality: personality,
                scenario: scenario,
                greeting: greeting,
                exampleDialogue: exampleDialogue,
                systemPrompt: systemPrompt,
                basicInfo: basicInfo,
                otherInfo: otherInfo,
                imageTags: imageTags,
                userImageTags: userImageTags,
                sortOrder: sortOrder,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                Value<String> name = const Value.absent(),
                Value<String?> avatarUrl = const Value.absent(),
                Value<String> personality = const Value.absent(),
                Value<String> scenario = const Value.absent(),
                Value<String> greeting = const Value.absent(),
                Value<String> exampleDialogue = const Value.absent(),
                Value<String> systemPrompt = const Value.absent(),
                Value<String> basicInfo = const Value.absent(),
                Value<String> otherInfo = const Value.absent(),
                Value<String> imageTags = const Value.absent(),
                Value<String> userImageTags = const Value.absent(),
                Value<int> sortOrder = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CharactersCompanion.insert(
                id: id,
                name: name,
                avatarUrl: avatarUrl,
                personality: personality,
                scenario: scenario,
                greeting: greeting,
                exampleDialogue: exampleDialogue,
                systemPrompt: systemPrompt,
                basicInfo: basicInfo,
                otherInfo: otherInfo,
                imageTags: imageTags,
                userImageTags: userImageTags,
                sortOrder: sortOrder,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$CharactersTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback:
              ({
                conversationsRefs = false,
                memoriesRefs = false,
                memoryTasksRefs = false,
                memoryEmbeddingsRefs = false,
                memoryEmbeddingTasksRefs = false,
                characterMemoryProfilesRefs = false,
                characterMemoryProfileUpdateTasksRefs = false,
                characterMemoryProfileVersionsRefs = false,
                memoryExtractionCandidatesRefs = false,
              }) {
                return PrefetchHooks(
                  db: db,
                  explicitlyWatchedTables: [
                    if (conversationsRefs) db.conversations,
                    if (memoriesRefs) db.memories,
                    if (memoryTasksRefs) db.memoryTasks,
                    if (memoryEmbeddingsRefs) db.memoryEmbeddings,
                    if (memoryEmbeddingTasksRefs) db.memoryEmbeddingTasks,
                    if (characterMemoryProfilesRefs) db.characterMemoryProfiles,
                    if (characterMemoryProfileUpdateTasksRefs)
                      db.characterMemoryProfileUpdateTasks,
                    if (characterMemoryProfileVersionsRefs)
                      db.characterMemoryProfileVersions,
                    if (memoryExtractionCandidatesRefs)
                      db.memoryExtractionCandidates,
                  ],
                  addJoins: null,
                  getPrefetchedDataCallback: (items) async {
                    return [
                      if (conversationsRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          Conversation
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._conversationsRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).conversationsRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (memoriesRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          Memory
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._memoriesRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).memoriesRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (memoryTasksRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          MemoryTask
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._memoryTasksRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).memoryTasksRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (memoryEmbeddingsRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          MemoryEmbedding
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._memoryEmbeddingsRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).memoryEmbeddingsRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (memoryEmbeddingTasksRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          MemoryEmbeddingTask
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._memoryEmbeddingTasksRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).memoryEmbeddingTasksRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (characterMemoryProfilesRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          CharacterMemoryProfile
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._characterMemoryProfilesRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).characterMemoryProfilesRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (characterMemoryProfileUpdateTasksRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          CharacterMemoryProfileUpdateTask
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._characterMemoryProfileUpdateTasksRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).characterMemoryProfileUpdateTasksRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (characterMemoryProfileVersionsRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          CharacterMemoryProfileVersion
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._characterMemoryProfileVersionsRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).characterMemoryProfileVersionsRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (memoryExtractionCandidatesRefs)
                        await $_getPrefetchedData<
                          Character,
                          $CharactersTable,
                          MemoryExtractionCandidate
                        >(
                          currentTable: table,
                          referencedTable: $$CharactersTableReferences
                              ._memoryExtractionCandidatesRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$CharactersTableReferences(
                                db,
                                table,
                                p0,
                              ).memoryExtractionCandidatesRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.characterId == item.id,
                              ),
                          typedResults: items,
                        ),
                    ];
                  },
                );
              },
        ),
      );
}

typedef $$CharactersTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CharactersTable,
      Character,
      $$CharactersTableFilterComposer,
      $$CharactersTableOrderingComposer,
      $$CharactersTableAnnotationComposer,
      $$CharactersTableCreateCompanionBuilder,
      $$CharactersTableUpdateCompanionBuilder,
      (Character, $$CharactersTableReferences),
      Character,
      PrefetchHooks Function({
        bool conversationsRefs,
        bool memoriesRefs,
        bool memoryTasksRefs,
        bool memoryEmbeddingsRefs,
        bool memoryEmbeddingTasksRefs,
        bool characterMemoryProfilesRefs,
        bool characterMemoryProfileUpdateTasksRefs,
        bool characterMemoryProfileVersionsRefs,
        bool memoryExtractionCandidatesRefs,
      })
    >;
typedef $$ConversationsTableCreateCompanionBuilder =
    ConversationsCompanion Function({
      required String id,
      required String characterId,
      Value<String> title,
      Value<int> ignoreMemory,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });
typedef $$ConversationsTableUpdateCompanionBuilder =
    ConversationsCompanion Function({
      Value<String> id,
      Value<String> characterId,
      Value<String> title,
      Value<int> ignoreMemory,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

final class $$ConversationsTableReferences
    extends BaseReferences<_$AppDatabase, $ConversationsTable, Conversation> {
  $$ConversationsTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(db.conversations.characterId, db.characters.id),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }

  static MultiTypedResultKey<$MessagesTable, List<Message>> _messagesRefsTable(
    _$AppDatabase db,
  ) => MultiTypedResultKey.fromTable(
    db.messages,
    aliasName: $_aliasNameGenerator(
      db.conversations.id,
      db.messages.conversationId,
    ),
  );

  $$MessagesTableProcessedTableManager get messagesRefs {
    final manager = $$MessagesTableTableManager(
      $_db,
      $_db.messages,
    ).filter((f) => f.conversationId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_messagesRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<$MemoryTasksTable, List<MemoryTask>>
  _memoryTasksRefsTable(_$AppDatabase db) => MultiTypedResultKey.fromTable(
    db.memoryTasks,
    aliasName: $_aliasNameGenerator(
      db.conversations.id,
      db.memoryTasks.conversationId,
    ),
  );

  $$MemoryTasksTableProcessedTableManager get memoryTasksRefs {
    final manager = $$MemoryTasksTableTableManager(
      $_db,
      $_db.memoryTasks,
    ).filter((f) => f.conversationId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_memoryTasksRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }
}

class $$ConversationsTableFilterComposer
    extends Composer<_$AppDatabase, $ConversationsTable> {
  $$ConversationsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get ignoreMemory => $composableBuilder(
    column: $table.ignoreMemory,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  Expression<bool> messagesRefs(
    Expression<bool> Function($$MessagesTableFilterComposer f) f,
  ) {
    final $$MessagesTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.messages,
      getReferencedColumn: (t) => t.conversationId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MessagesTableFilterComposer(
            $db: $db,
            $table: $db.messages,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> memoryTasksRefs(
    Expression<bool> Function($$MemoryTasksTableFilterComposer f) f,
  ) {
    final $$MemoryTasksTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryTasks,
      getReferencedColumn: (t) => t.conversationId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryTasksTableFilterComposer(
            $db: $db,
            $table: $db.memoryTasks,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }
}

class $$ConversationsTableOrderingComposer
    extends Composer<_$AppDatabase, $ConversationsTable> {
  $$ConversationsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get ignoreMemory => $composableBuilder(
    column: $table.ignoreMemory,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$ConversationsTableAnnotationComposer
    extends Composer<_$AppDatabase, $ConversationsTable> {
  $$ConversationsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get title =>
      $composableBuilder(column: $table.title, builder: (column) => column);

  GeneratedColumn<int> get ignoreMemory => $composableBuilder(
    column: $table.ignoreMemory,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  Expression<T> messagesRefs<T extends Object>(
    Expression<T> Function($$MessagesTableAnnotationComposer a) f,
  ) {
    final $$MessagesTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.messages,
      getReferencedColumn: (t) => t.conversationId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MessagesTableAnnotationComposer(
            $db: $db,
            $table: $db.messages,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<T> memoryTasksRefs<T extends Object>(
    Expression<T> Function($$MemoryTasksTableAnnotationComposer a) f,
  ) {
    final $$MemoryTasksTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryTasks,
      getReferencedColumn: (t) => t.conversationId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryTasksTableAnnotationComposer(
            $db: $db,
            $table: $db.memoryTasks,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }
}

class $$ConversationsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $ConversationsTable,
          Conversation,
          $$ConversationsTableFilterComposer,
          $$ConversationsTableOrderingComposer,
          $$ConversationsTableAnnotationComposer,
          $$ConversationsTableCreateCompanionBuilder,
          $$ConversationsTableUpdateCompanionBuilder,
          (Conversation, $$ConversationsTableReferences),
          Conversation,
          PrefetchHooks Function({
            bool characterId,
            bool messagesRefs,
            bool memoryTasksRefs,
          })
        > {
  $$ConversationsTableTableManager(_$AppDatabase db, $ConversationsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ConversationsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ConversationsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ConversationsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<String> title = const Value.absent(),
                Value<int> ignoreMemory = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ConversationsCompanion(
                id: id,
                characterId: characterId,
                title: title,
                ignoreMemory: ignoreMemory,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String characterId,
                Value<String> title = const Value.absent(),
                Value<int> ignoreMemory = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ConversationsCompanion.insert(
                id: id,
                characterId: characterId,
                title: title,
                ignoreMemory: ignoreMemory,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$ConversationsTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback:
              ({
                characterId = false,
                messagesRefs = false,
                memoryTasksRefs = false,
              }) {
                return PrefetchHooks(
                  db: db,
                  explicitlyWatchedTables: [
                    if (messagesRefs) db.messages,
                    if (memoryTasksRefs) db.memoryTasks,
                  ],
                  addJoins:
                      <
                        T extends TableManagerState<
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic
                        >
                      >(state) {
                        if (characterId) {
                          state =
                              state.withJoin(
                                    currentTable: table,
                                    currentColumn: table.characterId,
                                    referencedTable:
                                        $$ConversationsTableReferences
                                            ._characterIdTable(db),
                                    referencedColumn:
                                        $$ConversationsTableReferences
                                            ._characterIdTable(db)
                                            .id,
                                  )
                                  as T;
                        }

                        return state;
                      },
                  getPrefetchedDataCallback: (items) async {
                    return [
                      if (messagesRefs)
                        await $_getPrefetchedData<
                          Conversation,
                          $ConversationsTable,
                          Message
                        >(
                          currentTable: table,
                          referencedTable: $$ConversationsTableReferences
                              ._messagesRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$ConversationsTableReferences(
                                db,
                                table,
                                p0,
                              ).messagesRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.conversationId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (memoryTasksRefs)
                        await $_getPrefetchedData<
                          Conversation,
                          $ConversationsTable,
                          MemoryTask
                        >(
                          currentTable: table,
                          referencedTable: $$ConversationsTableReferences
                              ._memoryTasksRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$ConversationsTableReferences(
                                db,
                                table,
                                p0,
                              ).memoryTasksRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.conversationId == item.id,
                              ),
                          typedResults: items,
                        ),
                    ];
                  },
                );
              },
        ),
      );
}

typedef $$ConversationsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $ConversationsTable,
      Conversation,
      $$ConversationsTableFilterComposer,
      $$ConversationsTableOrderingComposer,
      $$ConversationsTableAnnotationComposer,
      $$ConversationsTableCreateCompanionBuilder,
      $$ConversationsTableUpdateCompanionBuilder,
      (Conversation, $$ConversationsTableReferences),
      Conversation,
      PrefetchHooks Function({
        bool characterId,
        bool messagesRefs,
        bool memoryTasksRefs,
      })
    >;
typedef $$MessagesTableCreateCompanionBuilder =
    MessagesCompanion Function({
      required String id,
      required String conversationId,
      required String role,
      Value<String> content,
      Value<int> tokenCount,
      Value<int> seq,
      Value<DateTime> createdAt,
      Value<String> metadata,
      Value<int> rowid,
    });
typedef $$MessagesTableUpdateCompanionBuilder =
    MessagesCompanion Function({
      Value<String> id,
      Value<String> conversationId,
      Value<String> role,
      Value<String> content,
      Value<int> tokenCount,
      Value<int> seq,
      Value<DateTime> createdAt,
      Value<String> metadata,
      Value<int> rowid,
    });

final class $$MessagesTableReferences
    extends BaseReferences<_$AppDatabase, $MessagesTable, Message> {
  $$MessagesTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static $ConversationsTable _conversationIdTable(_$AppDatabase db) =>
      db.conversations.createAlias(
        $_aliasNameGenerator(db.messages.conversationId, db.conversations.id),
      );

  $$ConversationsTableProcessedTableManager get conversationId {
    final $_column = $_itemColumn<String>('conversation_id')!;

    final manager = $$ConversationsTableTableManager(
      $_db,
      $_db.conversations,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_conversationIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$MessagesTableFilterComposer
    extends Composer<_$AppDatabase, $MessagesTable> {
  $$MessagesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get role => $composableBuilder(
    column: $table.role,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get content => $composableBuilder(
    column: $table.content,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get tokenCount => $composableBuilder(
    column: $table.tokenCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get seq => $composableBuilder(
    column: $table.seq,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get metadata => $composableBuilder(
    column: $table.metadata,
    builder: (column) => ColumnFilters(column),
  );

  $$ConversationsTableFilterComposer get conversationId {
    final $$ConversationsTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.conversationId,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableFilterComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MessagesTableOrderingComposer
    extends Composer<_$AppDatabase, $MessagesTable> {
  $$MessagesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get role => $composableBuilder(
    column: $table.role,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get content => $composableBuilder(
    column: $table.content,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get tokenCount => $composableBuilder(
    column: $table.tokenCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get seq => $composableBuilder(
    column: $table.seq,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get metadata => $composableBuilder(
    column: $table.metadata,
    builder: (column) => ColumnOrderings(column),
  );

  $$ConversationsTableOrderingComposer get conversationId {
    final $$ConversationsTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.conversationId,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableOrderingComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MessagesTableAnnotationComposer
    extends Composer<_$AppDatabase, $MessagesTable> {
  $$MessagesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get role =>
      $composableBuilder(column: $table.role, builder: (column) => column);

  GeneratedColumn<String> get content =>
      $composableBuilder(column: $table.content, builder: (column) => column);

  GeneratedColumn<int> get tokenCount => $composableBuilder(
    column: $table.tokenCount,
    builder: (column) => column,
  );

  GeneratedColumn<int> get seq =>
      $composableBuilder(column: $table.seq, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<String> get metadata =>
      $composableBuilder(column: $table.metadata, builder: (column) => column);

  $$ConversationsTableAnnotationComposer get conversationId {
    final $$ConversationsTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.conversationId,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableAnnotationComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MessagesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MessagesTable,
          Message,
          $$MessagesTableFilterComposer,
          $$MessagesTableOrderingComposer,
          $$MessagesTableAnnotationComposer,
          $$MessagesTableCreateCompanionBuilder,
          $$MessagesTableUpdateCompanionBuilder,
          (Message, $$MessagesTableReferences),
          Message,
          PrefetchHooks Function({bool conversationId})
        > {
  $$MessagesTableTableManager(_$AppDatabase db, $MessagesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MessagesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MessagesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$MessagesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> conversationId = const Value.absent(),
                Value<String> role = const Value.absent(),
                Value<String> content = const Value.absent(),
                Value<int> tokenCount = const Value.absent(),
                Value<int> seq = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<String> metadata = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => MessagesCompanion(
                id: id,
                conversationId: conversationId,
                role: role,
                content: content,
                tokenCount: tokenCount,
                seq: seq,
                createdAt: createdAt,
                metadata: metadata,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String conversationId,
                required String role,
                Value<String> content = const Value.absent(),
                Value<int> tokenCount = const Value.absent(),
                Value<int> seq = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<String> metadata = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => MessagesCompanion.insert(
                id: id,
                conversationId: conversationId,
                role: role,
                content: content,
                tokenCount: tokenCount,
                seq: seq,
                createdAt: createdAt,
                metadata: metadata,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$MessagesTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({conversationId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (conversationId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.conversationId,
                                referencedTable: $$MessagesTableReferences
                                    ._conversationIdTable(db),
                                referencedColumn: $$MessagesTableReferences
                                    ._conversationIdTable(db)
                                    .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$MessagesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MessagesTable,
      Message,
      $$MessagesTableFilterComposer,
      $$MessagesTableOrderingComposer,
      $$MessagesTableAnnotationComposer,
      $$MessagesTableCreateCompanionBuilder,
      $$MessagesTableUpdateCompanionBuilder,
      (Message, $$MessagesTableReferences),
      Message,
      PrefetchHooks Function({bool conversationId})
    >;
typedef $$MemoriesTableCreateCompanionBuilder =
    MemoriesCompanion Function({
      required String id,
      required String characterId,
      required String category,
      required String content,
      Value<double> confidence,
      Value<String> tags,
      Value<String> sourceMsgIds,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<String> memoryKind,
      Value<double> importance,
      Value<double> emotionalWeight,
      Value<String> status,
      Value<bool> pinned,
      Value<int?> lastUsedAt,
      Value<int> usageCount,
      Value<String?> metadata,
      Value<int> rowid,
    });
typedef $$MemoriesTableUpdateCompanionBuilder =
    MemoriesCompanion Function({
      Value<String> id,
      Value<String> characterId,
      Value<String> category,
      Value<String> content,
      Value<double> confidence,
      Value<String> tags,
      Value<String> sourceMsgIds,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<String> memoryKind,
      Value<double> importance,
      Value<double> emotionalWeight,
      Value<String> status,
      Value<bool> pinned,
      Value<int?> lastUsedAt,
      Value<int> usageCount,
      Value<String?> metadata,
      Value<int> rowid,
    });

final class $$MemoriesTableReferences
    extends BaseReferences<_$AppDatabase, $MemoriesTable, Memory> {
  $$MemoriesTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(db.memories.characterId, db.characters.id),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }

  static MultiTypedResultKey<$MemoryEmbeddingsTable, List<MemoryEmbedding>>
  _memoryEmbeddingsRefsTable(_$AppDatabase db) => MultiTypedResultKey.fromTable(
    db.memoryEmbeddings,
    aliasName: $_aliasNameGenerator(
      db.memories.id,
      db.memoryEmbeddings.memoryId,
    ),
  );

  $$MemoryEmbeddingsTableProcessedTableManager get memoryEmbeddingsRefs {
    final manager = $$MemoryEmbeddingsTableTableManager(
      $_db,
      $_db.memoryEmbeddings,
    ).filter((f) => f.memoryId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _memoryEmbeddingsRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<
    $MemoryEmbeddingTasksTable,
    List<MemoryEmbeddingTask>
  >
  _memoryEmbeddingTasksRefsTable(_$AppDatabase db) =>
      MultiTypedResultKey.fromTable(
        db.memoryEmbeddingTasks,
        aliasName: $_aliasNameGenerator(
          db.memories.id,
          db.memoryEmbeddingTasks.memoryId,
        ),
      );

  $$MemoryEmbeddingTasksTableProcessedTableManager
  get memoryEmbeddingTasksRefs {
    final manager = $$MemoryEmbeddingTasksTableTableManager(
      $_db,
      $_db.memoryEmbeddingTasks,
    ).filter((f) => f.memoryId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(
      _memoryEmbeddingTasksRefsTable($_db),
    );
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }
}

class $$MemoriesTableFilterComposer
    extends Composer<_$AppDatabase, $MemoriesTable> {
  $$MemoriesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get category => $composableBuilder(
    column: $table.category,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get content => $composableBuilder(
    column: $table.content,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get confidence => $composableBuilder(
    column: $table.confidence,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get tags => $composableBuilder(
    column: $table.tags,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sourceMsgIds => $composableBuilder(
    column: $table.sourceMsgIds,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get memoryKind => $composableBuilder(
    column: $table.memoryKind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get importance => $composableBuilder(
    column: $table.importance,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get emotionalWeight => $composableBuilder(
    column: $table.emotionalWeight,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get pinned => $composableBuilder(
    column: $table.pinned,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lastUsedAt => $composableBuilder(
    column: $table.lastUsedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get usageCount => $composableBuilder(
    column: $table.usageCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get metadata => $composableBuilder(
    column: $table.metadata,
    builder: (column) => ColumnFilters(column),
  );

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  Expression<bool> memoryEmbeddingsRefs(
    Expression<bool> Function($$MemoryEmbeddingsTableFilterComposer f) f,
  ) {
    final $$MemoryEmbeddingsTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryEmbeddings,
      getReferencedColumn: (t) => t.memoryId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryEmbeddingsTableFilterComposer(
            $db: $db,
            $table: $db.memoryEmbeddings,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> memoryEmbeddingTasksRefs(
    Expression<bool> Function($$MemoryEmbeddingTasksTableFilterComposer f) f,
  ) {
    final $$MemoryEmbeddingTasksTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryEmbeddingTasks,
      getReferencedColumn: (t) => t.memoryId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryEmbeddingTasksTableFilterComposer(
            $db: $db,
            $table: $db.memoryEmbeddingTasks,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }
}

class $$MemoriesTableOrderingComposer
    extends Composer<_$AppDatabase, $MemoriesTable> {
  $$MemoriesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get category => $composableBuilder(
    column: $table.category,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get content => $composableBuilder(
    column: $table.content,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get confidence => $composableBuilder(
    column: $table.confidence,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get tags => $composableBuilder(
    column: $table.tags,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sourceMsgIds => $composableBuilder(
    column: $table.sourceMsgIds,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get memoryKind => $composableBuilder(
    column: $table.memoryKind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get importance => $composableBuilder(
    column: $table.importance,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get emotionalWeight => $composableBuilder(
    column: $table.emotionalWeight,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get pinned => $composableBuilder(
    column: $table.pinned,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lastUsedAt => $composableBuilder(
    column: $table.lastUsedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get usageCount => $composableBuilder(
    column: $table.usageCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get metadata => $composableBuilder(
    column: $table.metadata,
    builder: (column) => ColumnOrderings(column),
  );

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoriesTableAnnotationComposer
    extends Composer<_$AppDatabase, $MemoriesTable> {
  $$MemoriesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get category =>
      $composableBuilder(column: $table.category, builder: (column) => column);

  GeneratedColumn<String> get content =>
      $composableBuilder(column: $table.content, builder: (column) => column);

  GeneratedColumn<double> get confidence => $composableBuilder(
    column: $table.confidence,
    builder: (column) => column,
  );

  GeneratedColumn<String> get tags =>
      $composableBuilder(column: $table.tags, builder: (column) => column);

  GeneratedColumn<String> get sourceMsgIds => $composableBuilder(
    column: $table.sourceMsgIds,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  GeneratedColumn<String> get memoryKind => $composableBuilder(
    column: $table.memoryKind,
    builder: (column) => column,
  );

  GeneratedColumn<double> get importance => $composableBuilder(
    column: $table.importance,
    builder: (column) => column,
  );

  GeneratedColumn<double> get emotionalWeight => $composableBuilder(
    column: $table.emotionalWeight,
    builder: (column) => column,
  );

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<bool> get pinned =>
      $composableBuilder(column: $table.pinned, builder: (column) => column);

  GeneratedColumn<int> get lastUsedAt => $composableBuilder(
    column: $table.lastUsedAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get usageCount => $composableBuilder(
    column: $table.usageCount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get metadata =>
      $composableBuilder(column: $table.metadata, builder: (column) => column);

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  Expression<T> memoryEmbeddingsRefs<T extends Object>(
    Expression<T> Function($$MemoryEmbeddingsTableAnnotationComposer a) f,
  ) {
    final $$MemoryEmbeddingsTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.memoryEmbeddings,
      getReferencedColumn: (t) => t.memoryId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoryEmbeddingsTableAnnotationComposer(
            $db: $db,
            $table: $db.memoryEmbeddings,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<T> memoryEmbeddingTasksRefs<T extends Object>(
    Expression<T> Function($$MemoryEmbeddingTasksTableAnnotationComposer a) f,
  ) {
    final $$MemoryEmbeddingTasksTableAnnotationComposer composer =
        $composerBuilder(
          composer: this,
          getCurrentColumn: (t) => t.id,
          referencedTable: $db.memoryEmbeddingTasks,
          getReferencedColumn: (t) => t.memoryId,
          builder:
              (
                joinBuilder, {
                $addJoinBuilderToRootComposer,
                $removeJoinBuilderFromRootComposer,
              }) => $$MemoryEmbeddingTasksTableAnnotationComposer(
                $db: $db,
                $table: $db.memoryEmbeddingTasks,
                $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
                joinBuilder: joinBuilder,
                $removeJoinBuilderFromRootComposer:
                    $removeJoinBuilderFromRootComposer,
              ),
        );
    return f(composer);
  }
}

class $$MemoriesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MemoriesTable,
          Memory,
          $$MemoriesTableFilterComposer,
          $$MemoriesTableOrderingComposer,
          $$MemoriesTableAnnotationComposer,
          $$MemoriesTableCreateCompanionBuilder,
          $$MemoriesTableUpdateCompanionBuilder,
          (Memory, $$MemoriesTableReferences),
          Memory,
          PrefetchHooks Function({
            bool characterId,
            bool memoryEmbeddingsRefs,
            bool memoryEmbeddingTasksRefs,
          })
        > {
  $$MemoriesTableTableManager(_$AppDatabase db, $MemoriesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MemoriesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MemoriesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$MemoriesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<String> category = const Value.absent(),
                Value<String> content = const Value.absent(),
                Value<double> confidence = const Value.absent(),
                Value<String> tags = const Value.absent(),
                Value<String> sourceMsgIds = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<String> memoryKind = const Value.absent(),
                Value<double> importance = const Value.absent(),
                Value<double> emotionalWeight = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<bool> pinned = const Value.absent(),
                Value<int?> lastUsedAt = const Value.absent(),
                Value<int> usageCount = const Value.absent(),
                Value<String?> metadata = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => MemoriesCompanion(
                id: id,
                characterId: characterId,
                category: category,
                content: content,
                confidence: confidence,
                tags: tags,
                sourceMsgIds: sourceMsgIds,
                createdAt: createdAt,
                updatedAt: updatedAt,
                memoryKind: memoryKind,
                importance: importance,
                emotionalWeight: emotionalWeight,
                status: status,
                pinned: pinned,
                lastUsedAt: lastUsedAt,
                usageCount: usageCount,
                metadata: metadata,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String characterId,
                required String category,
                required String content,
                Value<double> confidence = const Value.absent(),
                Value<String> tags = const Value.absent(),
                Value<String> sourceMsgIds = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<String> memoryKind = const Value.absent(),
                Value<double> importance = const Value.absent(),
                Value<double> emotionalWeight = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<bool> pinned = const Value.absent(),
                Value<int?> lastUsedAt = const Value.absent(),
                Value<int> usageCount = const Value.absent(),
                Value<String?> metadata = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => MemoriesCompanion.insert(
                id: id,
                characterId: characterId,
                category: category,
                content: content,
                confidence: confidence,
                tags: tags,
                sourceMsgIds: sourceMsgIds,
                createdAt: createdAt,
                updatedAt: updatedAt,
                memoryKind: memoryKind,
                importance: importance,
                emotionalWeight: emotionalWeight,
                status: status,
                pinned: pinned,
                lastUsedAt: lastUsedAt,
                usageCount: usageCount,
                metadata: metadata,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$MemoriesTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback:
              ({
                characterId = false,
                memoryEmbeddingsRefs = false,
                memoryEmbeddingTasksRefs = false,
              }) {
                return PrefetchHooks(
                  db: db,
                  explicitlyWatchedTables: [
                    if (memoryEmbeddingsRefs) db.memoryEmbeddings,
                    if (memoryEmbeddingTasksRefs) db.memoryEmbeddingTasks,
                  ],
                  addJoins:
                      <
                        T extends TableManagerState<
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic
                        >
                      >(state) {
                        if (characterId) {
                          state =
                              state.withJoin(
                                    currentTable: table,
                                    currentColumn: table.characterId,
                                    referencedTable: $$MemoriesTableReferences
                                        ._characterIdTable(db),
                                    referencedColumn: $$MemoriesTableReferences
                                        ._characterIdTable(db)
                                        .id,
                                  )
                                  as T;
                        }

                        return state;
                      },
                  getPrefetchedDataCallback: (items) async {
                    return [
                      if (memoryEmbeddingsRefs)
                        await $_getPrefetchedData<
                          Memory,
                          $MemoriesTable,
                          MemoryEmbedding
                        >(
                          currentTable: table,
                          referencedTable: $$MemoriesTableReferences
                              ._memoryEmbeddingsRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$MemoriesTableReferences(
                                db,
                                table,
                                p0,
                              ).memoryEmbeddingsRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.memoryId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (memoryEmbeddingTasksRefs)
                        await $_getPrefetchedData<
                          Memory,
                          $MemoriesTable,
                          MemoryEmbeddingTask
                        >(
                          currentTable: table,
                          referencedTable: $$MemoriesTableReferences
                              ._memoryEmbeddingTasksRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$MemoriesTableReferences(
                                db,
                                table,
                                p0,
                              ).memoryEmbeddingTasksRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.memoryId == item.id,
                              ),
                          typedResults: items,
                        ),
                    ];
                  },
                );
              },
        ),
      );
}

typedef $$MemoriesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MemoriesTable,
      Memory,
      $$MemoriesTableFilterComposer,
      $$MemoriesTableOrderingComposer,
      $$MemoriesTableAnnotationComposer,
      $$MemoriesTableCreateCompanionBuilder,
      $$MemoriesTableUpdateCompanionBuilder,
      (Memory, $$MemoriesTableReferences),
      Memory,
      PrefetchHooks Function({
        bool characterId,
        bool memoryEmbeddingsRefs,
        bool memoryEmbeddingTasksRefs,
      })
    >;
typedef $$SettingsTableCreateCompanionBuilder =
    SettingsCompanion Function({
      required String key,
      required String value,
      Value<int> rowid,
    });
typedef $$SettingsTableUpdateCompanionBuilder =
    SettingsCompanion Function({
      Value<String> key,
      Value<String> value,
      Value<int> rowid,
    });

class $$SettingsTableFilterComposer
    extends Composer<_$AppDatabase, $SettingsTable> {
  $$SettingsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get key => $composableBuilder(
    column: $table.key,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get value => $composableBuilder(
    column: $table.value,
    builder: (column) => ColumnFilters(column),
  );
}

class $$SettingsTableOrderingComposer
    extends Composer<_$AppDatabase, $SettingsTable> {
  $$SettingsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get key => $composableBuilder(
    column: $table.key,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get value => $composableBuilder(
    column: $table.value,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$SettingsTableAnnotationComposer
    extends Composer<_$AppDatabase, $SettingsTable> {
  $$SettingsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get key =>
      $composableBuilder(column: $table.key, builder: (column) => column);

  GeneratedColumn<String> get value =>
      $composableBuilder(column: $table.value, builder: (column) => column);
}

class $$SettingsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $SettingsTable,
          Setting,
          $$SettingsTableFilterComposer,
          $$SettingsTableOrderingComposer,
          $$SettingsTableAnnotationComposer,
          $$SettingsTableCreateCompanionBuilder,
          $$SettingsTableUpdateCompanionBuilder,
          (Setting, BaseReferences<_$AppDatabase, $SettingsTable, Setting>),
          Setting,
          PrefetchHooks Function()
        > {
  $$SettingsTableTableManager(_$AppDatabase db, $SettingsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$SettingsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$SettingsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$SettingsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> key = const Value.absent(),
                Value<String> value = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => SettingsCompanion(key: key, value: value, rowid: rowid),
          createCompanionCallback:
              ({
                required String key,
                required String value,
                Value<int> rowid = const Value.absent(),
              }) => SettingsCompanion.insert(
                key: key,
                value: value,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$SettingsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $SettingsTable,
      Setting,
      $$SettingsTableFilterComposer,
      $$SettingsTableOrderingComposer,
      $$SettingsTableAnnotationComposer,
      $$SettingsTableCreateCompanionBuilder,
      $$SettingsTableUpdateCompanionBuilder,
      (Setting, BaseReferences<_$AppDatabase, $SettingsTable, Setting>),
      Setting,
      PrefetchHooks Function()
    >;
typedef $$MemoryTasksTableCreateCompanionBuilder =
    MemoryTasksCompanion Function({
      Value<int> id,
      required String characterId,
      required String conversationId,
      Value<String> messageIds,
      Value<String> status,
      Value<int> mergeCount,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int?> startedAt,
      Value<int> retryCount,
      Value<String?> errorMessage,
    });
typedef $$MemoryTasksTableUpdateCompanionBuilder =
    MemoryTasksCompanion Function({
      Value<int> id,
      Value<String> characterId,
      Value<String> conversationId,
      Value<String> messageIds,
      Value<String> status,
      Value<int> mergeCount,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
      Value<int?> startedAt,
      Value<int> retryCount,
      Value<String?> errorMessage,
    });

final class $$MemoryTasksTableReferences
    extends BaseReferences<_$AppDatabase, $MemoryTasksTable, MemoryTask> {
  $$MemoryTasksTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(db.memoryTasks.characterId, db.characters.id),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }

  static $ConversationsTable _conversationIdTable(_$AppDatabase db) =>
      db.conversations.createAlias(
        $_aliasNameGenerator(
          db.memoryTasks.conversationId,
          db.conversations.id,
        ),
      );

  $$ConversationsTableProcessedTableManager get conversationId {
    final $_column = $_itemColumn<String>('conversation_id')!;

    final manager = $$ConversationsTableTableManager(
      $_db,
      $_db.conversations,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_conversationIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$MemoryTasksTableFilterComposer
    extends Composer<_$AppDatabase, $MemoryTasksTable> {
  $$MemoryTasksTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get messageIds => $composableBuilder(
    column: $table.messageIds,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get mergeCount => $composableBuilder(
    column: $table.mergeCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get startedAt => $composableBuilder(
    column: $table.startedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnFilters(column),
  );

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$ConversationsTableFilterComposer get conversationId {
    final $$ConversationsTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.conversationId,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableFilterComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryTasksTableOrderingComposer
    extends Composer<_$AppDatabase, $MemoryTasksTable> {
  $$MemoryTasksTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get messageIds => $composableBuilder(
    column: $table.messageIds,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get mergeCount => $composableBuilder(
    column: $table.mergeCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get startedAt => $composableBuilder(
    column: $table.startedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnOrderings(column),
  );

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$ConversationsTableOrderingComposer get conversationId {
    final $$ConversationsTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.conversationId,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableOrderingComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryTasksTableAnnotationComposer
    extends Composer<_$AppDatabase, $MemoryTasksTable> {
  $$MemoryTasksTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get messageIds => $composableBuilder(
    column: $table.messageIds,
    builder: (column) => column,
  );

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<int> get mergeCount => $composableBuilder(
    column: $table.mergeCount,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  GeneratedColumn<int> get startedAt =>
      $composableBuilder(column: $table.startedAt, builder: (column) => column);

  GeneratedColumn<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => column,
  );

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$ConversationsTableAnnotationComposer get conversationId {
    final $$ConversationsTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.conversationId,
      referencedTable: $db.conversations,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$ConversationsTableAnnotationComposer(
            $db: $db,
            $table: $db.conversations,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryTasksTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MemoryTasksTable,
          MemoryTask,
          $$MemoryTasksTableFilterComposer,
          $$MemoryTasksTableOrderingComposer,
          $$MemoryTasksTableAnnotationComposer,
          $$MemoryTasksTableCreateCompanionBuilder,
          $$MemoryTasksTableUpdateCompanionBuilder,
          (MemoryTask, $$MemoryTasksTableReferences),
          MemoryTask,
          PrefetchHooks Function({bool characterId, bool conversationId})
        > {
  $$MemoryTasksTableTableManager(_$AppDatabase db, $MemoryTasksTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MemoryTasksTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MemoryTasksTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$MemoryTasksTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<String> conversationId = const Value.absent(),
                Value<String> messageIds = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int> mergeCount = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int?> startedAt = const Value.absent(),
                Value<int> retryCount = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
              }) => MemoryTasksCompanion(
                id: id,
                characterId: characterId,
                conversationId: conversationId,
                messageIds: messageIds,
                status: status,
                mergeCount: mergeCount,
                createdAt: createdAt,
                updatedAt: updatedAt,
                startedAt: startedAt,
                retryCount: retryCount,
                errorMessage: errorMessage,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String characterId,
                required String conversationId,
                Value<String> messageIds = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int> mergeCount = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int?> startedAt = const Value.absent(),
                Value<int> retryCount = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
              }) => MemoryTasksCompanion.insert(
                id: id,
                characterId: characterId,
                conversationId: conversationId,
                messageIds: messageIds,
                status: status,
                mergeCount: mergeCount,
                createdAt: createdAt,
                updatedAt: updatedAt,
                startedAt: startedAt,
                retryCount: retryCount,
                errorMessage: errorMessage,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$MemoryTasksTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback:
              ({characterId = false, conversationId = false}) {
                return PrefetchHooks(
                  db: db,
                  explicitlyWatchedTables: [],
                  addJoins:
                      <
                        T extends TableManagerState<
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic,
                          dynamic
                        >
                      >(state) {
                        if (characterId) {
                          state =
                              state.withJoin(
                                    currentTable: table,
                                    currentColumn: table.characterId,
                                    referencedTable:
                                        $$MemoryTasksTableReferences
                                            ._characterIdTable(db),
                                    referencedColumn:
                                        $$MemoryTasksTableReferences
                                            ._characterIdTable(db)
                                            .id,
                                  )
                                  as T;
                        }
                        if (conversationId) {
                          state =
                              state.withJoin(
                                    currentTable: table,
                                    currentColumn: table.conversationId,
                                    referencedTable:
                                        $$MemoryTasksTableReferences
                                            ._conversationIdTable(db),
                                    referencedColumn:
                                        $$MemoryTasksTableReferences
                                            ._conversationIdTable(db)
                                            .id,
                                  )
                                  as T;
                        }

                        return state;
                      },
                  getPrefetchedDataCallback: (items) async {
                    return [];
                  },
                );
              },
        ),
      );
}

typedef $$MemoryTasksTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MemoryTasksTable,
      MemoryTask,
      $$MemoryTasksTableFilterComposer,
      $$MemoryTasksTableOrderingComposer,
      $$MemoryTasksTableAnnotationComposer,
      $$MemoryTasksTableCreateCompanionBuilder,
      $$MemoryTasksTableUpdateCompanionBuilder,
      (MemoryTask, $$MemoryTasksTableReferences),
      MemoryTask,
      PrefetchHooks Function({bool characterId, bool conversationId})
    >;
typedef $$ModelCacheTableCreateCompanionBuilder =
    ModelCacheCompanion Function({
      required String apiBase,
      Value<String> models,
      Value<DateTime> cachedAt,
      Value<int> rowid,
    });
typedef $$ModelCacheTableUpdateCompanionBuilder =
    ModelCacheCompanion Function({
      Value<String> apiBase,
      Value<String> models,
      Value<DateTime> cachedAt,
      Value<int> rowid,
    });

class $$ModelCacheTableFilterComposer
    extends Composer<_$AppDatabase, $ModelCacheTable> {
  $$ModelCacheTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get apiBase => $composableBuilder(
    column: $table.apiBase,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get models => $composableBuilder(
    column: $table.models,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get cachedAt => $composableBuilder(
    column: $table.cachedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ModelCacheTableOrderingComposer
    extends Composer<_$AppDatabase, $ModelCacheTable> {
  $$ModelCacheTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get apiBase => $composableBuilder(
    column: $table.apiBase,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get models => $composableBuilder(
    column: $table.models,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get cachedAt => $composableBuilder(
    column: $table.cachedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ModelCacheTableAnnotationComposer
    extends Composer<_$AppDatabase, $ModelCacheTable> {
  $$ModelCacheTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get apiBase =>
      $composableBuilder(column: $table.apiBase, builder: (column) => column);

  GeneratedColumn<String> get models =>
      $composableBuilder(column: $table.models, builder: (column) => column);

  GeneratedColumn<DateTime> get cachedAt =>
      $composableBuilder(column: $table.cachedAt, builder: (column) => column);
}

class $$ModelCacheTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $ModelCacheTable,
          ModelCacheData,
          $$ModelCacheTableFilterComposer,
          $$ModelCacheTableOrderingComposer,
          $$ModelCacheTableAnnotationComposer,
          $$ModelCacheTableCreateCompanionBuilder,
          $$ModelCacheTableUpdateCompanionBuilder,
          (
            ModelCacheData,
            BaseReferences<_$AppDatabase, $ModelCacheTable, ModelCacheData>,
          ),
          ModelCacheData,
          PrefetchHooks Function()
        > {
  $$ModelCacheTableTableManager(_$AppDatabase db, $ModelCacheTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ModelCacheTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ModelCacheTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ModelCacheTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> apiBase = const Value.absent(),
                Value<String> models = const Value.absent(),
                Value<DateTime> cachedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ModelCacheCompanion(
                apiBase: apiBase,
                models: models,
                cachedAt: cachedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String apiBase,
                Value<String> models = const Value.absent(),
                Value<DateTime> cachedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ModelCacheCompanion.insert(
                apiBase: apiBase,
                models: models,
                cachedAt: cachedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ModelCacheTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $ModelCacheTable,
      ModelCacheData,
      $$ModelCacheTableFilterComposer,
      $$ModelCacheTableOrderingComposer,
      $$ModelCacheTableAnnotationComposer,
      $$ModelCacheTableCreateCompanionBuilder,
      $$ModelCacheTableUpdateCompanionBuilder,
      (
        ModelCacheData,
        BaseReferences<_$AppDatabase, $ModelCacheTable, ModelCacheData>,
      ),
      ModelCacheData,
      PrefetchHooks Function()
    >;
typedef $$ApiProvidersTableCreateCompanionBuilder =
    ApiProvidersCompanion Function({
      required String id,
      required String name,
      Value<String> apiBase,
      Value<String> apiKey,
      Value<String> model,
      Value<double> temperature,
      Value<int> maxTokens,
      Value<int> contextWindow,
      Value<int> jsonMode,
      Value<DateTime> createdAt,
      Value<int> rowid,
    });
typedef $$ApiProvidersTableUpdateCompanionBuilder =
    ApiProvidersCompanion Function({
      Value<String> id,
      Value<String> name,
      Value<String> apiBase,
      Value<String> apiKey,
      Value<String> model,
      Value<double> temperature,
      Value<int> maxTokens,
      Value<int> contextWindow,
      Value<int> jsonMode,
      Value<DateTime> createdAt,
      Value<int> rowid,
    });

class $$ApiProvidersTableFilterComposer
    extends Composer<_$AppDatabase, $ApiProvidersTable> {
  $$ApiProvidersTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get apiBase => $composableBuilder(
    column: $table.apiBase,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get apiKey => $composableBuilder(
    column: $table.apiKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get temperature => $composableBuilder(
    column: $table.temperature,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get maxTokens => $composableBuilder(
    column: $table.maxTokens,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get contextWindow => $composableBuilder(
    column: $table.contextWindow,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get jsonMode => $composableBuilder(
    column: $table.jsonMode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ApiProvidersTableOrderingComposer
    extends Composer<_$AppDatabase, $ApiProvidersTable> {
  $$ApiProvidersTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get apiBase => $composableBuilder(
    column: $table.apiBase,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get apiKey => $composableBuilder(
    column: $table.apiKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get temperature => $composableBuilder(
    column: $table.temperature,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get maxTokens => $composableBuilder(
    column: $table.maxTokens,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get contextWindow => $composableBuilder(
    column: $table.contextWindow,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get jsonMode => $composableBuilder(
    column: $table.jsonMode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ApiProvidersTableAnnotationComposer
    extends Composer<_$AppDatabase, $ApiProvidersTable> {
  $$ApiProvidersTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get apiBase =>
      $composableBuilder(column: $table.apiBase, builder: (column) => column);

  GeneratedColumn<String> get apiKey =>
      $composableBuilder(column: $table.apiKey, builder: (column) => column);

  GeneratedColumn<String> get model =>
      $composableBuilder(column: $table.model, builder: (column) => column);

  GeneratedColumn<double> get temperature => $composableBuilder(
    column: $table.temperature,
    builder: (column) => column,
  );

  GeneratedColumn<int> get maxTokens =>
      $composableBuilder(column: $table.maxTokens, builder: (column) => column);

  GeneratedColumn<int> get contextWindow => $composableBuilder(
    column: $table.contextWindow,
    builder: (column) => column,
  );

  GeneratedColumn<int> get jsonMode =>
      $composableBuilder(column: $table.jsonMode, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);
}

class $$ApiProvidersTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $ApiProvidersTable,
          ApiProvider,
          $$ApiProvidersTableFilterComposer,
          $$ApiProvidersTableOrderingComposer,
          $$ApiProvidersTableAnnotationComposer,
          $$ApiProvidersTableCreateCompanionBuilder,
          $$ApiProvidersTableUpdateCompanionBuilder,
          (
            ApiProvider,
            BaseReferences<_$AppDatabase, $ApiProvidersTable, ApiProvider>,
          ),
          ApiProvider,
          PrefetchHooks Function()
        > {
  $$ApiProvidersTableTableManager(_$AppDatabase db, $ApiProvidersTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ApiProvidersTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ApiProvidersTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ApiProvidersTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String> apiBase = const Value.absent(),
                Value<String> apiKey = const Value.absent(),
                Value<String> model = const Value.absent(),
                Value<double> temperature = const Value.absent(),
                Value<int> maxTokens = const Value.absent(),
                Value<int> contextWindow = const Value.absent(),
                Value<int> jsonMode = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ApiProvidersCompanion(
                id: id,
                name: name,
                apiBase: apiBase,
                apiKey: apiKey,
                model: model,
                temperature: temperature,
                maxTokens: maxTokens,
                contextWindow: contextWindow,
                jsonMode: jsonMode,
                createdAt: createdAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String name,
                Value<String> apiBase = const Value.absent(),
                Value<String> apiKey = const Value.absent(),
                Value<String> model = const Value.absent(),
                Value<double> temperature = const Value.absent(),
                Value<int> maxTokens = const Value.absent(),
                Value<int> contextWindow = const Value.absent(),
                Value<int> jsonMode = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ApiProvidersCompanion.insert(
                id: id,
                name: name,
                apiBase: apiBase,
                apiKey: apiKey,
                model: model,
                temperature: temperature,
                maxTokens: maxTokens,
                contextWindow: contextWindow,
                jsonMode: jsonMode,
                createdAt: createdAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ApiProvidersTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $ApiProvidersTable,
      ApiProvider,
      $$ApiProvidersTableFilterComposer,
      $$ApiProvidersTableOrderingComposer,
      $$ApiProvidersTableAnnotationComposer,
      $$ApiProvidersTableCreateCompanionBuilder,
      $$ApiProvidersTableUpdateCompanionBuilder,
      (
        ApiProvider,
        BaseReferences<_$AppDatabase, $ApiProvidersTable, ApiProvider>,
      ),
      ApiProvider,
      PrefetchHooks Function()
    >;
typedef $$MemoryEmbeddingsTableCreateCompanionBuilder =
    MemoryEmbeddingsCompanion Function({
      Value<int> id,
      required String memoryId,
      required String characterId,
      required String provider,
      required String model,
      required int dimension,
      required Uint8List embeddingBlob,
      Value<int> normalized,
      required String embeddingTextHash,
      Value<String> status,
      Value<String?> errorMessage,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });
typedef $$MemoryEmbeddingsTableUpdateCompanionBuilder =
    MemoryEmbeddingsCompanion Function({
      Value<int> id,
      Value<String> memoryId,
      Value<String> characterId,
      Value<String> provider,
      Value<String> model,
      Value<int> dimension,
      Value<Uint8List> embeddingBlob,
      Value<int> normalized,
      Value<String> embeddingTextHash,
      Value<String> status,
      Value<String?> errorMessage,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });

final class $$MemoryEmbeddingsTableReferences
    extends
        BaseReferences<_$AppDatabase, $MemoryEmbeddingsTable, MemoryEmbedding> {
  $$MemoryEmbeddingsTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $MemoriesTable _memoryIdTable(_$AppDatabase db) =>
      db.memories.createAlias(
        $_aliasNameGenerator(db.memoryEmbeddings.memoryId, db.memories.id),
      );

  $$MemoriesTableProcessedTableManager get memoryId {
    final $_column = $_itemColumn<String>('memory_id')!;

    final manager = $$MemoriesTableTableManager(
      $_db,
      $_db.memories,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_memoryIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(db.memoryEmbeddings.characterId, db.characters.id),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$MemoryEmbeddingsTableFilterComposer
    extends Composer<_$AppDatabase, $MemoryEmbeddingsTable> {
  $$MemoryEmbeddingsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get provider => $composableBuilder(
    column: $table.provider,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get dimension => $composableBuilder(
    column: $table.dimension,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<Uint8List> get embeddingBlob => $composableBuilder(
    column: $table.embeddingBlob,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get normalized => $composableBuilder(
    column: $table.normalized,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get embeddingTextHash => $composableBuilder(
    column: $table.embeddingTextHash,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  $$MemoriesTableFilterComposer get memoryId {
    final $$MemoriesTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.memoryId,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableFilterComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryEmbeddingsTableOrderingComposer
    extends Composer<_$AppDatabase, $MemoryEmbeddingsTable> {
  $$MemoryEmbeddingsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get provider => $composableBuilder(
    column: $table.provider,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get dimension => $composableBuilder(
    column: $table.dimension,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<Uint8List> get embeddingBlob => $composableBuilder(
    column: $table.embeddingBlob,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get normalized => $composableBuilder(
    column: $table.normalized,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get embeddingTextHash => $composableBuilder(
    column: $table.embeddingTextHash,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$MemoriesTableOrderingComposer get memoryId {
    final $$MemoriesTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.memoryId,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableOrderingComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryEmbeddingsTableAnnotationComposer
    extends Composer<_$AppDatabase, $MemoryEmbeddingsTable> {
  $$MemoryEmbeddingsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get provider =>
      $composableBuilder(column: $table.provider, builder: (column) => column);

  GeneratedColumn<String> get model =>
      $composableBuilder(column: $table.model, builder: (column) => column);

  GeneratedColumn<int> get dimension =>
      $composableBuilder(column: $table.dimension, builder: (column) => column);

  GeneratedColumn<Uint8List> get embeddingBlob => $composableBuilder(
    column: $table.embeddingBlob,
    builder: (column) => column,
  );

  GeneratedColumn<int> get normalized => $composableBuilder(
    column: $table.normalized,
    builder: (column) => column,
  );

  GeneratedColumn<String> get embeddingTextHash => $composableBuilder(
    column: $table.embeddingTextHash,
    builder: (column) => column,
  );

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  $$MemoriesTableAnnotationComposer get memoryId {
    final $$MemoriesTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.memoryId,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableAnnotationComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryEmbeddingsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MemoryEmbeddingsTable,
          MemoryEmbedding,
          $$MemoryEmbeddingsTableFilterComposer,
          $$MemoryEmbeddingsTableOrderingComposer,
          $$MemoryEmbeddingsTableAnnotationComposer,
          $$MemoryEmbeddingsTableCreateCompanionBuilder,
          $$MemoryEmbeddingsTableUpdateCompanionBuilder,
          (MemoryEmbedding, $$MemoryEmbeddingsTableReferences),
          MemoryEmbedding,
          PrefetchHooks Function({bool memoryId, bool characterId})
        > {
  $$MemoryEmbeddingsTableTableManager(
    _$AppDatabase db,
    $MemoryEmbeddingsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MemoryEmbeddingsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MemoryEmbeddingsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$MemoryEmbeddingsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> memoryId = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<String> provider = const Value.absent(),
                Value<String> model = const Value.absent(),
                Value<int> dimension = const Value.absent(),
                Value<Uint8List> embeddingBlob = const Value.absent(),
                Value<int> normalized = const Value.absent(),
                Value<String> embeddingTextHash = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => MemoryEmbeddingsCompanion(
                id: id,
                memoryId: memoryId,
                characterId: characterId,
                provider: provider,
                model: model,
                dimension: dimension,
                embeddingBlob: embeddingBlob,
                normalized: normalized,
                embeddingTextHash: embeddingTextHash,
                status: status,
                errorMessage: errorMessage,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String memoryId,
                required String characterId,
                required String provider,
                required String model,
                required int dimension,
                required Uint8List embeddingBlob,
                Value<int> normalized = const Value.absent(),
                required String embeddingTextHash,
                Value<String> status = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => MemoryEmbeddingsCompanion.insert(
                id: id,
                memoryId: memoryId,
                characterId: characterId,
                provider: provider,
                model: model,
                dimension: dimension,
                embeddingBlob: embeddingBlob,
                normalized: normalized,
                embeddingTextHash: embeddingTextHash,
                status: status,
                errorMessage: errorMessage,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$MemoryEmbeddingsTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({memoryId = false, characterId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (memoryId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.memoryId,
                                referencedTable:
                                    $$MemoryEmbeddingsTableReferences
                                        ._memoryIdTable(db),
                                referencedColumn:
                                    $$MemoryEmbeddingsTableReferences
                                        ._memoryIdTable(db)
                                        .id,
                              )
                              as T;
                    }
                    if (characterId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.characterId,
                                referencedTable:
                                    $$MemoryEmbeddingsTableReferences
                                        ._characterIdTable(db),
                                referencedColumn:
                                    $$MemoryEmbeddingsTableReferences
                                        ._characterIdTable(db)
                                        .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$MemoryEmbeddingsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MemoryEmbeddingsTable,
      MemoryEmbedding,
      $$MemoryEmbeddingsTableFilterComposer,
      $$MemoryEmbeddingsTableOrderingComposer,
      $$MemoryEmbeddingsTableAnnotationComposer,
      $$MemoryEmbeddingsTableCreateCompanionBuilder,
      $$MemoryEmbeddingsTableUpdateCompanionBuilder,
      (MemoryEmbedding, $$MemoryEmbeddingsTableReferences),
      MemoryEmbedding,
      PrefetchHooks Function({bool memoryId, bool characterId})
    >;
typedef $$MemoryEmbeddingTasksTableCreateCompanionBuilder =
    MemoryEmbeddingTasksCompanion Function({
      Value<int> id,
      required String memoryId,
      required String characterId,
      required String reason,
      Value<String> status,
      Value<String?> claimToken,
      Value<int> retryCount,
      Value<String?> errorMessage,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });
typedef $$MemoryEmbeddingTasksTableUpdateCompanionBuilder =
    MemoryEmbeddingTasksCompanion Function({
      Value<int> id,
      Value<String> memoryId,
      Value<String> characterId,
      Value<String> reason,
      Value<String> status,
      Value<String?> claimToken,
      Value<int> retryCount,
      Value<String?> errorMessage,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });

final class $$MemoryEmbeddingTasksTableReferences
    extends
        BaseReferences<
          _$AppDatabase,
          $MemoryEmbeddingTasksTable,
          MemoryEmbeddingTask
        > {
  $$MemoryEmbeddingTasksTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $MemoriesTable _memoryIdTable(_$AppDatabase db) =>
      db.memories.createAlias(
        $_aliasNameGenerator(db.memoryEmbeddingTasks.memoryId, db.memories.id),
      );

  $$MemoriesTableProcessedTableManager get memoryId {
    final $_column = $_itemColumn<String>('memory_id')!;

    final manager = $$MemoriesTableTableManager(
      $_db,
      $_db.memories,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_memoryIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(
          db.memoryEmbeddingTasks.characterId,
          db.characters.id,
        ),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$MemoryEmbeddingTasksTableFilterComposer
    extends Composer<_$AppDatabase, $MemoryEmbeddingTasksTable> {
  $$MemoryEmbeddingTasksTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get claimToken => $composableBuilder(
    column: $table.claimToken,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  $$MemoriesTableFilterComposer get memoryId {
    final $$MemoriesTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.memoryId,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableFilterComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryEmbeddingTasksTableOrderingComposer
    extends Composer<_$AppDatabase, $MemoryEmbeddingTasksTable> {
  $$MemoryEmbeddingTasksTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get claimToken => $composableBuilder(
    column: $table.claimToken,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$MemoriesTableOrderingComposer get memoryId {
    final $$MemoriesTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.memoryId,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableOrderingComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryEmbeddingTasksTableAnnotationComposer
    extends Composer<_$AppDatabase, $MemoryEmbeddingTasksTable> {
  $$MemoryEmbeddingTasksTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get reason =>
      $composableBuilder(column: $table.reason, builder: (column) => column);

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<String> get claimToken => $composableBuilder(
    column: $table.claimToken,
    builder: (column) => column,
  );

  GeneratedColumn<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  $$MemoriesTableAnnotationComposer get memoryId {
    final $$MemoriesTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.memoryId,
      referencedTable: $db.memories,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$MemoriesTableAnnotationComposer(
            $db: $db,
            $table: $db.memories,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryEmbeddingTasksTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MemoryEmbeddingTasksTable,
          MemoryEmbeddingTask,
          $$MemoryEmbeddingTasksTableFilterComposer,
          $$MemoryEmbeddingTasksTableOrderingComposer,
          $$MemoryEmbeddingTasksTableAnnotationComposer,
          $$MemoryEmbeddingTasksTableCreateCompanionBuilder,
          $$MemoryEmbeddingTasksTableUpdateCompanionBuilder,
          (MemoryEmbeddingTask, $$MemoryEmbeddingTasksTableReferences),
          MemoryEmbeddingTask,
          PrefetchHooks Function({bool memoryId, bool characterId})
        > {
  $$MemoryEmbeddingTasksTableTableManager(
    _$AppDatabase db,
    $MemoryEmbeddingTasksTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MemoryEmbeddingTasksTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MemoryEmbeddingTasksTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$MemoryEmbeddingTasksTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> memoryId = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<String> reason = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<String?> claimToken = const Value.absent(),
                Value<int> retryCount = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => MemoryEmbeddingTasksCompanion(
                id: id,
                memoryId: memoryId,
                characterId: characterId,
                reason: reason,
                status: status,
                claimToken: claimToken,
                retryCount: retryCount,
                errorMessage: errorMessage,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String memoryId,
                required String characterId,
                required String reason,
                Value<String> status = const Value.absent(),
                Value<String?> claimToken = const Value.absent(),
                Value<int> retryCount = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => MemoryEmbeddingTasksCompanion.insert(
                id: id,
                memoryId: memoryId,
                characterId: characterId,
                reason: reason,
                status: status,
                claimToken: claimToken,
                retryCount: retryCount,
                errorMessage: errorMessage,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$MemoryEmbeddingTasksTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({memoryId = false, characterId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (memoryId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.memoryId,
                                referencedTable:
                                    $$MemoryEmbeddingTasksTableReferences
                                        ._memoryIdTable(db),
                                referencedColumn:
                                    $$MemoryEmbeddingTasksTableReferences
                                        ._memoryIdTable(db)
                                        .id,
                              )
                              as T;
                    }
                    if (characterId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.characterId,
                                referencedTable:
                                    $$MemoryEmbeddingTasksTableReferences
                                        ._characterIdTable(db),
                                referencedColumn:
                                    $$MemoryEmbeddingTasksTableReferences
                                        ._characterIdTable(db)
                                        .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$MemoryEmbeddingTasksTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MemoryEmbeddingTasksTable,
      MemoryEmbeddingTask,
      $$MemoryEmbeddingTasksTableFilterComposer,
      $$MemoryEmbeddingTasksTableOrderingComposer,
      $$MemoryEmbeddingTasksTableAnnotationComposer,
      $$MemoryEmbeddingTasksTableCreateCompanionBuilder,
      $$MemoryEmbeddingTasksTableUpdateCompanionBuilder,
      (MemoryEmbeddingTask, $$MemoryEmbeddingTasksTableReferences),
      MemoryEmbeddingTask,
      PrefetchHooks Function({bool memoryId, bool characterId})
    >;
typedef $$CharacterMemoryProfilesTableCreateCompanionBuilder =
    CharacterMemoryProfilesCompanion Function({
      required String characterId,
      Value<String> profileName,
      Value<String> relationshipState,
      Value<String> recentStoryState,
      Value<String> emotionalBaseline,
      Value<String> openThreads,
      Value<String> userProfileSummary,
      Value<String> pinnedSummary,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });
typedef $$CharacterMemoryProfilesTableUpdateCompanionBuilder =
    CharacterMemoryProfilesCompanion Function({
      Value<String> characterId,
      Value<String> profileName,
      Value<String> relationshipState,
      Value<String> recentStoryState,
      Value<String> emotionalBaseline,
      Value<String> openThreads,
      Value<String> userProfileSummary,
      Value<String> pinnedSummary,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

final class $$CharacterMemoryProfilesTableReferences
    extends
        BaseReferences<
          _$AppDatabase,
          $CharacterMemoryProfilesTable,
          CharacterMemoryProfile
        > {
  $$CharacterMemoryProfilesTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(
          db.characterMemoryProfiles.characterId,
          db.characters.id,
        ),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$CharacterMemoryProfilesTableFilterComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfilesTable> {
  $$CharacterMemoryProfilesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get profileName => $composableBuilder(
    column: $table.profileName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get relationshipState => $composableBuilder(
    column: $table.relationshipState,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get recentStoryState => $composableBuilder(
    column: $table.recentStoryState,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get emotionalBaseline => $composableBuilder(
    column: $table.emotionalBaseline,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get openThreads => $composableBuilder(
    column: $table.openThreads,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get userProfileSummary => $composableBuilder(
    column: $table.userProfileSummary,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get pinnedSummary => $composableBuilder(
    column: $table.pinnedSummary,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfilesTableOrderingComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfilesTable> {
  $$CharacterMemoryProfilesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get profileName => $composableBuilder(
    column: $table.profileName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get relationshipState => $composableBuilder(
    column: $table.relationshipState,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get recentStoryState => $composableBuilder(
    column: $table.recentStoryState,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get emotionalBaseline => $composableBuilder(
    column: $table.emotionalBaseline,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get openThreads => $composableBuilder(
    column: $table.openThreads,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get userProfileSummary => $composableBuilder(
    column: $table.userProfileSummary,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get pinnedSummary => $composableBuilder(
    column: $table.pinnedSummary,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfilesTableAnnotationComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfilesTable> {
  $$CharacterMemoryProfilesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get profileName => $composableBuilder(
    column: $table.profileName,
    builder: (column) => column,
  );

  GeneratedColumn<String> get relationshipState => $composableBuilder(
    column: $table.relationshipState,
    builder: (column) => column,
  );

  GeneratedColumn<String> get recentStoryState => $composableBuilder(
    column: $table.recentStoryState,
    builder: (column) => column,
  );

  GeneratedColumn<String> get emotionalBaseline => $composableBuilder(
    column: $table.emotionalBaseline,
    builder: (column) => column,
  );

  GeneratedColumn<String> get openThreads => $composableBuilder(
    column: $table.openThreads,
    builder: (column) => column,
  );

  GeneratedColumn<String> get userProfileSummary => $composableBuilder(
    column: $table.userProfileSummary,
    builder: (column) => column,
  );

  GeneratedColumn<String> get pinnedSummary => $composableBuilder(
    column: $table.pinnedSummary,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfilesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CharacterMemoryProfilesTable,
          CharacterMemoryProfile,
          $$CharacterMemoryProfilesTableFilterComposer,
          $$CharacterMemoryProfilesTableOrderingComposer,
          $$CharacterMemoryProfilesTableAnnotationComposer,
          $$CharacterMemoryProfilesTableCreateCompanionBuilder,
          $$CharacterMemoryProfilesTableUpdateCompanionBuilder,
          (CharacterMemoryProfile, $$CharacterMemoryProfilesTableReferences),
          CharacterMemoryProfile,
          PrefetchHooks Function({bool characterId})
        > {
  $$CharacterMemoryProfilesTableTableManager(
    _$AppDatabase db,
    $CharacterMemoryProfilesTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CharacterMemoryProfilesTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$CharacterMemoryProfilesTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$CharacterMemoryProfilesTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> characterId = const Value.absent(),
                Value<String> profileName = const Value.absent(),
                Value<String> relationshipState = const Value.absent(),
                Value<String> recentStoryState = const Value.absent(),
                Value<String> emotionalBaseline = const Value.absent(),
                Value<String> openThreads = const Value.absent(),
                Value<String> userProfileSummary = const Value.absent(),
                Value<String> pinnedSummary = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CharacterMemoryProfilesCompanion(
                characterId: characterId,
                profileName: profileName,
                relationshipState: relationshipState,
                recentStoryState: recentStoryState,
                emotionalBaseline: emotionalBaseline,
                openThreads: openThreads,
                userProfileSummary: userProfileSummary,
                pinnedSummary: pinnedSummary,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String characterId,
                Value<String> profileName = const Value.absent(),
                Value<String> relationshipState = const Value.absent(),
                Value<String> recentStoryState = const Value.absent(),
                Value<String> emotionalBaseline = const Value.absent(),
                Value<String> openThreads = const Value.absent(),
                Value<String> userProfileSummary = const Value.absent(),
                Value<String> pinnedSummary = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CharacterMemoryProfilesCompanion.insert(
                characterId: characterId,
                profileName: profileName,
                relationshipState: relationshipState,
                recentStoryState: recentStoryState,
                emotionalBaseline: emotionalBaseline,
                openThreads: openThreads,
                userProfileSummary: userProfileSummary,
                pinnedSummary: pinnedSummary,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$CharacterMemoryProfilesTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({characterId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (characterId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.characterId,
                                referencedTable:
                                    $$CharacterMemoryProfilesTableReferences
                                        ._characterIdTable(db),
                                referencedColumn:
                                    $$CharacterMemoryProfilesTableReferences
                                        ._characterIdTable(db)
                                        .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$CharacterMemoryProfilesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CharacterMemoryProfilesTable,
      CharacterMemoryProfile,
      $$CharacterMemoryProfilesTableFilterComposer,
      $$CharacterMemoryProfilesTableOrderingComposer,
      $$CharacterMemoryProfilesTableAnnotationComposer,
      $$CharacterMemoryProfilesTableCreateCompanionBuilder,
      $$CharacterMemoryProfilesTableUpdateCompanionBuilder,
      (CharacterMemoryProfile, $$CharacterMemoryProfilesTableReferences),
      CharacterMemoryProfile,
      PrefetchHooks Function({bool characterId})
    >;
typedef $$CharacterMemoryProfileUpdateTasksTableCreateCompanionBuilder =
    CharacterMemoryProfileUpdateTasksCompanion Function({
      Value<int> id,
      required String characterId,
      required String reason,
      required String patchJson,
      Value<String> status,
      Value<String?> claimToken,
      Value<int?> leaseExpiresAt,
      Value<int> retryCount,
      Value<String?> errorMessage,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });
typedef $$CharacterMemoryProfileUpdateTasksTableUpdateCompanionBuilder =
    CharacterMemoryProfileUpdateTasksCompanion Function({
      Value<int> id,
      Value<String> characterId,
      Value<String> reason,
      Value<String> patchJson,
      Value<String> status,
      Value<String?> claimToken,
      Value<int?> leaseExpiresAt,
      Value<int> retryCount,
      Value<String?> errorMessage,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });

final class $$CharacterMemoryProfileUpdateTasksTableReferences
    extends
        BaseReferences<
          _$AppDatabase,
          $CharacterMemoryProfileUpdateTasksTable,
          CharacterMemoryProfileUpdateTask
        > {
  $$CharacterMemoryProfileUpdateTasksTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(
          db.characterMemoryProfileUpdateTasks.characterId,
          db.characters.id,
        ),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$CharacterMemoryProfileUpdateTasksTableFilterComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfileUpdateTasksTable> {
  $$CharacterMemoryProfileUpdateTasksTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get patchJson => $composableBuilder(
    column: $table.patchJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get claimToken => $composableBuilder(
    column: $table.claimToken,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get leaseExpiresAt => $composableBuilder(
    column: $table.leaseExpiresAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfileUpdateTasksTableOrderingComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfileUpdateTasksTable> {
  $$CharacterMemoryProfileUpdateTasksTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get patchJson => $composableBuilder(
    column: $table.patchJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get claimToken => $composableBuilder(
    column: $table.claimToken,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get leaseExpiresAt => $composableBuilder(
    column: $table.leaseExpiresAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfileUpdateTasksTable> {
  $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get reason =>
      $composableBuilder(column: $table.reason, builder: (column) => column);

  GeneratedColumn<String> get patchJson =>
      $composableBuilder(column: $table.patchJson, builder: (column) => column);

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<String> get claimToken => $composableBuilder(
    column: $table.claimToken,
    builder: (column) => column,
  );

  GeneratedColumn<int> get leaseExpiresAt => $composableBuilder(
    column: $table.leaseExpiresAt,
    builder: (column) => column,
  );

  GeneratedColumn<int> get retryCount => $composableBuilder(
    column: $table.retryCount,
    builder: (column) => column,
  );

  GeneratedColumn<String> get errorMessage => $composableBuilder(
    column: $table.errorMessage,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfileUpdateTasksTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CharacterMemoryProfileUpdateTasksTable,
          CharacterMemoryProfileUpdateTask,
          $$CharacterMemoryProfileUpdateTasksTableFilterComposer,
          $$CharacterMemoryProfileUpdateTasksTableOrderingComposer,
          $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer,
          $$CharacterMemoryProfileUpdateTasksTableCreateCompanionBuilder,
          $$CharacterMemoryProfileUpdateTasksTableUpdateCompanionBuilder,
          (
            CharacterMemoryProfileUpdateTask,
            $$CharacterMemoryProfileUpdateTasksTableReferences,
          ),
          CharacterMemoryProfileUpdateTask,
          PrefetchHooks Function({bool characterId})
        > {
  $$CharacterMemoryProfileUpdateTasksTableTableManager(
    _$AppDatabase db,
    $CharacterMemoryProfileUpdateTasksTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CharacterMemoryProfileUpdateTasksTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$CharacterMemoryProfileUpdateTasksTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<String> reason = const Value.absent(),
                Value<String> patchJson = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<String?> claimToken = const Value.absent(),
                Value<int?> leaseExpiresAt = const Value.absent(),
                Value<int> retryCount = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => CharacterMemoryProfileUpdateTasksCompanion(
                id: id,
                characterId: characterId,
                reason: reason,
                patchJson: patchJson,
                status: status,
                claimToken: claimToken,
                leaseExpiresAt: leaseExpiresAt,
                retryCount: retryCount,
                errorMessage: errorMessage,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String characterId,
                required String reason,
                required String patchJson,
                Value<String> status = const Value.absent(),
                Value<String?> claimToken = const Value.absent(),
                Value<int?> leaseExpiresAt = const Value.absent(),
                Value<int> retryCount = const Value.absent(),
                Value<String?> errorMessage = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => CharacterMemoryProfileUpdateTasksCompanion.insert(
                id: id,
                characterId: characterId,
                reason: reason,
                patchJson: patchJson,
                status: status,
                claimToken: claimToken,
                leaseExpiresAt: leaseExpiresAt,
                retryCount: retryCount,
                errorMessage: errorMessage,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$CharacterMemoryProfileUpdateTasksTableReferences(
                    db,
                    table,
                    e,
                  ),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({characterId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (characterId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.characterId,
                                referencedTable:
                                    $$CharacterMemoryProfileUpdateTasksTableReferences
                                        ._characterIdTable(db),
                                referencedColumn:
                                    $$CharacterMemoryProfileUpdateTasksTableReferences
                                        ._characterIdTable(db)
                                        .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$CharacterMemoryProfileUpdateTasksTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CharacterMemoryProfileUpdateTasksTable,
      CharacterMemoryProfileUpdateTask,
      $$CharacterMemoryProfileUpdateTasksTableFilterComposer,
      $$CharacterMemoryProfileUpdateTasksTableOrderingComposer,
      $$CharacterMemoryProfileUpdateTasksTableAnnotationComposer,
      $$CharacterMemoryProfileUpdateTasksTableCreateCompanionBuilder,
      $$CharacterMemoryProfileUpdateTasksTableUpdateCompanionBuilder,
      (
        CharacterMemoryProfileUpdateTask,
        $$CharacterMemoryProfileUpdateTasksTableReferences,
      ),
      CharacterMemoryProfileUpdateTask,
      PrefetchHooks Function({bool characterId})
    >;
typedef $$CharacterMemoryProfileVersionsTableCreateCompanionBuilder =
    CharacterMemoryProfileVersionsCompanion Function({
      Value<int> id,
      required String characterId,
      required int versionNumber,
      required String snapshotJson,
      required String reason,
      Value<int?> taskId,
      Value<DateTime> createdAt,
    });
typedef $$CharacterMemoryProfileVersionsTableUpdateCompanionBuilder =
    CharacterMemoryProfileVersionsCompanion Function({
      Value<int> id,
      Value<String> characterId,
      Value<int> versionNumber,
      Value<String> snapshotJson,
      Value<String> reason,
      Value<int?> taskId,
      Value<DateTime> createdAt,
    });

final class $$CharacterMemoryProfileVersionsTableReferences
    extends
        BaseReferences<
          _$AppDatabase,
          $CharacterMemoryProfileVersionsTable,
          CharacterMemoryProfileVersion
        > {
  $$CharacterMemoryProfileVersionsTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(
          db.characterMemoryProfileVersions.characterId,
          db.characters.id,
        ),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$CharacterMemoryProfileVersionsTableFilterComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfileVersionsTable> {
  $$CharacterMemoryProfileVersionsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get versionNumber => $composableBuilder(
    column: $table.versionNumber,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get snapshotJson => $composableBuilder(
    column: $table.snapshotJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get taskId => $composableBuilder(
    column: $table.taskId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfileVersionsTableOrderingComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfileVersionsTable> {
  $$CharacterMemoryProfileVersionsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get versionNumber => $composableBuilder(
    column: $table.versionNumber,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get snapshotJson => $composableBuilder(
    column: $table.snapshotJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get taskId => $composableBuilder(
    column: $table.taskId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfileVersionsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CharacterMemoryProfileVersionsTable> {
  $$CharacterMemoryProfileVersionsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<int> get versionNumber => $composableBuilder(
    column: $table.versionNumber,
    builder: (column) => column,
  );

  GeneratedColumn<String> get snapshotJson => $composableBuilder(
    column: $table.snapshotJson,
    builder: (column) => column,
  );

  GeneratedColumn<String> get reason =>
      $composableBuilder(column: $table.reason, builder: (column) => column);

  GeneratedColumn<int> get taskId =>
      $composableBuilder(column: $table.taskId, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$CharacterMemoryProfileVersionsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CharacterMemoryProfileVersionsTable,
          CharacterMemoryProfileVersion,
          $$CharacterMemoryProfileVersionsTableFilterComposer,
          $$CharacterMemoryProfileVersionsTableOrderingComposer,
          $$CharacterMemoryProfileVersionsTableAnnotationComposer,
          $$CharacterMemoryProfileVersionsTableCreateCompanionBuilder,
          $$CharacterMemoryProfileVersionsTableUpdateCompanionBuilder,
          (
            CharacterMemoryProfileVersion,
            $$CharacterMemoryProfileVersionsTableReferences,
          ),
          CharacterMemoryProfileVersion,
          PrefetchHooks Function({bool characterId})
        > {
  $$CharacterMemoryProfileVersionsTableTableManager(
    _$AppDatabase db,
    $CharacterMemoryProfileVersionsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CharacterMemoryProfileVersionsTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$CharacterMemoryProfileVersionsTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$CharacterMemoryProfileVersionsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<int> versionNumber = const Value.absent(),
                Value<String> snapshotJson = const Value.absent(),
                Value<String> reason = const Value.absent(),
                Value<int?> taskId = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
              }) => CharacterMemoryProfileVersionsCompanion(
                id: id,
                characterId: characterId,
                versionNumber: versionNumber,
                snapshotJson: snapshotJson,
                reason: reason,
                taskId: taskId,
                createdAt: createdAt,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String characterId,
                required int versionNumber,
                required String snapshotJson,
                required String reason,
                Value<int?> taskId = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
              }) => CharacterMemoryProfileVersionsCompanion.insert(
                id: id,
                characterId: characterId,
                versionNumber: versionNumber,
                snapshotJson: snapshotJson,
                reason: reason,
                taskId: taskId,
                createdAt: createdAt,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$CharacterMemoryProfileVersionsTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({characterId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (characterId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.characterId,
                                referencedTable:
                                    $$CharacterMemoryProfileVersionsTableReferences
                                        ._characterIdTable(db),
                                referencedColumn:
                                    $$CharacterMemoryProfileVersionsTableReferences
                                        ._characterIdTable(db)
                                        .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$CharacterMemoryProfileVersionsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CharacterMemoryProfileVersionsTable,
      CharacterMemoryProfileVersion,
      $$CharacterMemoryProfileVersionsTableFilterComposer,
      $$CharacterMemoryProfileVersionsTableOrderingComposer,
      $$CharacterMemoryProfileVersionsTableAnnotationComposer,
      $$CharacterMemoryProfileVersionsTableCreateCompanionBuilder,
      $$CharacterMemoryProfileVersionsTableUpdateCompanionBuilder,
      (
        CharacterMemoryProfileVersion,
        $$CharacterMemoryProfileVersionsTableReferences,
      ),
      CharacterMemoryProfileVersion,
      PrefetchHooks Function({bool characterId})
    >;
typedef $$MemoryExtractionCandidatesTableCreateCompanionBuilder =
    MemoryExtractionCandidatesCompanion Function({
      Value<int> id,
      Value<int?> taskId,
      required String characterId,
      Value<String?> conversationId,
      Value<String?> rawCandidateJson,
      Value<String?> rawResponse,
      required String status,
      Value<String?> errorReason,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });
typedef $$MemoryExtractionCandidatesTableUpdateCompanionBuilder =
    MemoryExtractionCandidatesCompanion Function({
      Value<int> id,
      Value<int?> taskId,
      Value<String> characterId,
      Value<String?> conversationId,
      Value<String?> rawCandidateJson,
      Value<String?> rawResponse,
      Value<String> status,
      Value<String?> errorReason,
      Value<DateTime> createdAt,
      Value<DateTime> updatedAt,
    });

final class $$MemoryExtractionCandidatesTableReferences
    extends
        BaseReferences<
          _$AppDatabase,
          $MemoryExtractionCandidatesTable,
          MemoryExtractionCandidate
        > {
  $$MemoryExtractionCandidatesTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $CharactersTable _characterIdTable(_$AppDatabase db) =>
      db.characters.createAlias(
        $_aliasNameGenerator(
          db.memoryExtractionCandidates.characterId,
          db.characters.id,
        ),
      );

  $$CharactersTableProcessedTableManager get characterId {
    final $_column = $_itemColumn<String>('character_id')!;

    final manager = $$CharactersTableTableManager(
      $_db,
      $_db.characters,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_characterIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$MemoryExtractionCandidatesTableFilterComposer
    extends Composer<_$AppDatabase, $MemoryExtractionCandidatesTable> {
  $$MemoryExtractionCandidatesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get taskId => $composableBuilder(
    column: $table.taskId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get conversationId => $composableBuilder(
    column: $table.conversationId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rawCandidateJson => $composableBuilder(
    column: $table.rawCandidateJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rawResponse => $composableBuilder(
    column: $table.rawResponse,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get errorReason => $composableBuilder(
    column: $table.errorReason,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );

  $$CharactersTableFilterComposer get characterId {
    final $$CharactersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableFilterComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryExtractionCandidatesTableOrderingComposer
    extends Composer<_$AppDatabase, $MemoryExtractionCandidatesTable> {
  $$MemoryExtractionCandidatesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get taskId => $composableBuilder(
    column: $table.taskId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get conversationId => $composableBuilder(
    column: $table.conversationId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rawCandidateJson => $composableBuilder(
    column: $table.rawCandidateJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rawResponse => $composableBuilder(
    column: $table.rawResponse,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get errorReason => $composableBuilder(
    column: $table.errorReason,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$CharactersTableOrderingComposer get characterId {
    final $$CharactersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableOrderingComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryExtractionCandidatesTableAnnotationComposer
    extends Composer<_$AppDatabase, $MemoryExtractionCandidatesTable> {
  $$MemoryExtractionCandidatesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<int> get taskId =>
      $composableBuilder(column: $table.taskId, builder: (column) => column);

  GeneratedColumn<String> get conversationId => $composableBuilder(
    column: $table.conversationId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get rawCandidateJson => $composableBuilder(
    column: $table.rawCandidateJson,
    builder: (column) => column,
  );

  GeneratedColumn<String> get rawResponse => $composableBuilder(
    column: $table.rawResponse,
    builder: (column) => column,
  );

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<String> get errorReason => $composableBuilder(
    column: $table.errorReason,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);

  $$CharactersTableAnnotationComposer get characterId {
    final $$CharactersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.characterId,
      referencedTable: $db.characters,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CharactersTableAnnotationComposer(
            $db: $db,
            $table: $db.characters,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$MemoryExtractionCandidatesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MemoryExtractionCandidatesTable,
          MemoryExtractionCandidate,
          $$MemoryExtractionCandidatesTableFilterComposer,
          $$MemoryExtractionCandidatesTableOrderingComposer,
          $$MemoryExtractionCandidatesTableAnnotationComposer,
          $$MemoryExtractionCandidatesTableCreateCompanionBuilder,
          $$MemoryExtractionCandidatesTableUpdateCompanionBuilder,
          (
            MemoryExtractionCandidate,
            $$MemoryExtractionCandidatesTableReferences,
          ),
          MemoryExtractionCandidate,
          PrefetchHooks Function({bool characterId})
        > {
  $$MemoryExtractionCandidatesTableTableManager(
    _$AppDatabase db,
    $MemoryExtractionCandidatesTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MemoryExtractionCandidatesTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$MemoryExtractionCandidatesTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$MemoryExtractionCandidatesTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<int?> taskId = const Value.absent(),
                Value<String> characterId = const Value.absent(),
                Value<String?> conversationId = const Value.absent(),
                Value<String?> rawCandidateJson = const Value.absent(),
                Value<String?> rawResponse = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<String?> errorReason = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => MemoryExtractionCandidatesCompanion(
                id: id,
                taskId: taskId,
                characterId: characterId,
                conversationId: conversationId,
                rawCandidateJson: rawCandidateJson,
                rawResponse: rawResponse,
                status: status,
                errorReason: errorReason,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<int?> taskId = const Value.absent(),
                required String characterId,
                Value<String?> conversationId = const Value.absent(),
                Value<String?> rawCandidateJson = const Value.absent(),
                Value<String?> rawResponse = const Value.absent(),
                required String status,
                Value<String?> errorReason = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
              }) => MemoryExtractionCandidatesCompanion.insert(
                id: id,
                taskId: taskId,
                characterId: characterId,
                conversationId: conversationId,
                rawCandidateJson: rawCandidateJson,
                rawResponse: rawResponse,
                status: status,
                errorReason: errorReason,
                createdAt: createdAt,
                updatedAt: updatedAt,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$MemoryExtractionCandidatesTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({characterId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (characterId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.characterId,
                                referencedTable:
                                    $$MemoryExtractionCandidatesTableReferences
                                        ._characterIdTable(db),
                                referencedColumn:
                                    $$MemoryExtractionCandidatesTableReferences
                                        ._characterIdTable(db)
                                        .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$MemoryExtractionCandidatesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MemoryExtractionCandidatesTable,
      MemoryExtractionCandidate,
      $$MemoryExtractionCandidatesTableFilterComposer,
      $$MemoryExtractionCandidatesTableOrderingComposer,
      $$MemoryExtractionCandidatesTableAnnotationComposer,
      $$MemoryExtractionCandidatesTableCreateCompanionBuilder,
      $$MemoryExtractionCandidatesTableUpdateCompanionBuilder,
      (MemoryExtractionCandidate, $$MemoryExtractionCandidatesTableReferences),
      MemoryExtractionCandidate,
      PrefetchHooks Function({bool characterId})
    >;

class $AppDatabaseManager {
  final _$AppDatabase _db;
  $AppDatabaseManager(this._db);
  $$CharactersTableTableManager get characters =>
      $$CharactersTableTableManager(_db, _db.characters);
  $$ConversationsTableTableManager get conversations =>
      $$ConversationsTableTableManager(_db, _db.conversations);
  $$MessagesTableTableManager get messages =>
      $$MessagesTableTableManager(_db, _db.messages);
  $$MemoriesTableTableManager get memories =>
      $$MemoriesTableTableManager(_db, _db.memories);
  $$SettingsTableTableManager get settings =>
      $$SettingsTableTableManager(_db, _db.settings);
  $$MemoryTasksTableTableManager get memoryTasks =>
      $$MemoryTasksTableTableManager(_db, _db.memoryTasks);
  $$ModelCacheTableTableManager get modelCache =>
      $$ModelCacheTableTableManager(_db, _db.modelCache);
  $$ApiProvidersTableTableManager get apiProviders =>
      $$ApiProvidersTableTableManager(_db, _db.apiProviders);
  $$MemoryEmbeddingsTableTableManager get memoryEmbeddings =>
      $$MemoryEmbeddingsTableTableManager(_db, _db.memoryEmbeddings);
  $$MemoryEmbeddingTasksTableTableManager get memoryEmbeddingTasks =>
      $$MemoryEmbeddingTasksTableTableManager(_db, _db.memoryEmbeddingTasks);
  $$CharacterMemoryProfilesTableTableManager get characterMemoryProfiles =>
      $$CharacterMemoryProfilesTableTableManager(
        _db,
        _db.characterMemoryProfiles,
      );
  $$CharacterMemoryProfileUpdateTasksTableTableManager
  get characterMemoryProfileUpdateTasks =>
      $$CharacterMemoryProfileUpdateTasksTableTableManager(
        _db,
        _db.characterMemoryProfileUpdateTasks,
      );
  $$CharacterMemoryProfileVersionsTableTableManager
  get characterMemoryProfileVersions =>
      $$CharacterMemoryProfileVersionsTableTableManager(
        _db,
        _db.characterMemoryProfileVersions,
      );
  $$MemoryExtractionCandidatesTableTableManager
  get memoryExtractionCandidates =>
      $$MemoryExtractionCandidatesTableTableManager(
        _db,
        _db.memoryExtractionCandidates,
      );
}
